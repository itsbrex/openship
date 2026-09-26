import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Dockerode from "dockerode";
import { DockerRuntime } from "@repo/adapters";
import { eventually, exec, freePort } from "./scaling-lab";

const run = promisify(execFile);
const fixture = join(import.meta.dirname, "../fixtures/cluster-host");
const sq = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Real Linux/systemd/SSH machines in an isolated Docker network. Nothing uses
 * registered user servers, the developer's SSH keys, or the host Docker socket. */
export class ClusterHostLab {
  readonly id = `stateful-${randomUUID().slice(0, 8)}`;
  readonly nodes: Array<{
    id: string;
    name: string;
    privateIp: string;
    sshPort: number;
    container: Dockerode.Container;
  }> = [];
  private runtime?: DockerRuntime;
  private network?: Dockerode.Network;
  private volumes: Dockerode.Volume[] = [];
  private directory = "";
  private extra: Dockerode.Container[] = [];
  private image = "";
  privateKey = "";
  networkCidrs: string[] = [];
  get networkName() {
    return this.id;
  }
  get docker() {
    return this.runtime!.docker;
  }

  async start(count = 3) {
    const disk = await statfs(tmpdir());
    if (disk.bavail * disk.bsize < 25 * 1024 ** 3)
      throw new Error(
        "The host/storage scaling journey needs at least 25 GiB of free local disk space for isolated Linux hosts, storage images and recovery data.",
      );
    this.runtime = await DockerRuntime.create({ transport: "socket" });
    await this.runtime.assertReachable();
    if ((await this.docker.info()).MemTotal < 6 * 1024 ** 3 - 256 * 1024 ** 2)
      throw new Error("The stateful scaling journey needs at least 6 GiB of Docker memory.");
    this.directory = await mkdtemp(join(tmpdir(), "openship-cluster-hosts-"));
    const key = join(this.directory, "id_ed25519");
    await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key]);
    this.privateKey = await readFile(key, "utf8");
    const publicKey = await readFile(key + ".pub", "utf8");
    this.image = `openship-e2e:${this.id}-host`;
    console.info("[stateful-e2e] Building isolated Linux hosts with systemd and SSH.");
    const build = await this.docker.buildImage(
      { context: fixture, src: ["Dockerfile"] },
      { t: this.image },
    );
    await new Promise<void>((resolve, reject) =>
      this.docker.modem.followProgress(
        build,
        (error) => (error ? reject(error) : resolve()),
        (event: { stream?: string }) => {
          if (event.stream?.trim()) console.info(`[stateful-e2e:host] ${event.stream.trim()}`);
        },
      ),
    );
    this.network = await this.docker.createNetwork({
      Name: this.id,
      Labels: { "openship.e2e": this.id },
    });
    this.networkCidrs = ((await this.network.inspect()).IPAM?.Config ?? [])
      .map((config) => config.Subnet)
      .filter((subnet): subnet is string => !!subnet);
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      const name = `${this.id}-server-${index + 1}`;
      const volumeName = `${name}-data`;
      await this.docker.createVolume({ Name: volumeName, Labels: { "openship.e2e": this.id } });
      this.volumes.push(this.docker.getVolume(volumeName));
      // Nested containerd needs a real filesystem, not the host container's
      // overlay upperdir. Keep runtime images separate from the storage disk.
      const runtimeVolumeName = `${name}-runtime`;
      await this.docker.createVolume({
        Name: runtimeVolumeName,
        Labels: { "openship.e2e": this.id },
      });
      this.volumes.push(this.docker.getVolume(runtimeVolumeName));
      const container = await this.docker.createContainer({
        name,
        Hostname: name,
        Image: this.image,
        Labels: { "openship.e2e": this.id },
        ExposedPorts: { "22/tcp": {} },
        Entrypoint: ["/bin/sh", "-ec"],
        Cmd: [
          `mkdir -p /root/.ssh; printf %s ${sq(Buffer.from(publicKey).toString("base64"))} | base64 -d > /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys; ssh-keygen -A; mount --make-rshared /; exec /sbin/init`,
        ],
        HostConfig: {
          Privileged: true,
          ...{ CgroupnsMode: "private" },
          NetworkMode: this.id,
          Tmpfs: { "/run": "", "/run/lock": "", "/tmp": "" },
          Binds: ["/lib/modules:/lib/modules:ro"],
          Mounts: [
            { Type: "volume", Source: volumeName, Target: "/var/lib/openship" },
            { Type: "volume", Source: runtimeVolumeName, Target: "/var/lib/rancher" },
          ],
          PortBindings: { "22/tcp": [{ HostIp: "127.0.0.1", HostPort: await freePort() }] },
        },
      });
      this.extra.push(container);
      await container.start();
      const info = await container.inspect();
      this.nodes.push({
        id,
        name,
        privateIp: info.NetworkSettings.Networks[this.id].IPAddress,
        sshPort: Number(info.NetworkSettings.Ports["22/tcp"]![0].HostPort),
        container,
      });
      await eventually(
        `${name}'s SSH service`,
        () => exec(this.docker, container, ["systemctl", "is-active", "ssh"]),
        (output) => output.trim() === "active",
        60_000,
      );
    }
    console.info(`[stateful-e2e] ${count} Linux hosts are ready for real setup.`);
  }
  async container(options: Dockerode.ContainerCreateOptions) {
    if (options.Image) {
      try {
        await this.docker.getImage(options.Image).inspect();
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        await this.runtime!.pullImage(options.Image);
      }
    }
    const container = await this.docker.createContainer({
      ...options,
      Labels: { ...options.Labels, "openship.e2e": this.id },
      HostConfig: { ...options.HostConfig, NetworkMode: this.id },
    });
    this.extra.push(container);
    await container.start();
    return container;
  }
  exec(index: number, command: string[], timeout = 45) {
    return exec(this.docker, this.nodes[index].container, command, timeout);
  }
  async diagnostics() {
    for (const [index, node] of this.nodes.entries()) {
      for (const command of [
        ["systemctl", "--failed", "--no-pager"],
        ["journalctl", "-u", "k3s", "-n", "40", "--no-pager"],
        [
          "sh",
          "-c",
          "test ! -f /etc/rancher/k3s/k3s.yaml || /usr/local/bin/k3s kubectl --request-timeout=10s get pods -A -o wide",
        ],
        [
          "sh",
          "-c",
          "test ! -f /etc/rancher/k3s/k3s.yaml || /usr/local/bin/k3s kubectl --request-timeout=10s get events -A --sort-by=.lastTimestamp | tail -40",
        ],
      ]) {
        try {
          console.error(`[${node.name}] ${await this.exec(index, command)}`);
        } catch (error) {
          console.error(String(error));
        }
      }
    }
  }
  async close() {
    const failures: unknown[] = [];
    for (const container of [...this.extra].reverse()) {
      try {
        const info = await container.inspect();
        if (info.Config.Labels?.["openship.e2e"] !== this.id)
          throw new Error("Refusing to remove a foreign fixture container.");
        if (info.State.Paused) await container.unpause();
        if (info.State.Running && this.nodes.some((node) => node.container.id === container.id)) {
          // systemd must stop its nested containers before Docker unmounts
          // the fixture disks. Force removal alone can leave busy mounts.
          await exec(
            this.docker,
            container,
            [
              "sh",
              "-c",
              "if [ -x /usr/local/bin/k3s-killall.sh ]; then /usr/local/bin/k3s-killall.sh; fi",
            ],
            45,
          ).catch((error) => console.error(String(error)));
          await container.stop({ t: 15 }).catch((error) => {
            if ((error as { statusCode?: number }).statusCode !== 304) throw error;
          });
        }
        await container.remove({ force: true, v: true });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) failures.push(error);
      }
    }
    for (const volume of this.volumes) {
      try {
        if ((await volume.inspect()).Labels?.["openship.e2e"] !== this.id)
          throw new Error("Refusing to remove a foreign data disk.");
        await volume.remove();
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) failures.push(error);
      }
    }
    await this.network?.remove().catch((error) => failures.push(error));
    if (this.image)
      await this.docker
        .getImage(this.image)
        .remove({ force: true, noprune: true })
        .catch((error) => failures.push(error));
    await this.runtime?.dispose();
    if (this.directory) await rm(this.directory, { force: true, recursive: true });
    if (failures.length)
      throw new AggregateError(
        failures,
        `Stateful scaling lab cleanup failed: ${failures.map(String).join("; ")}`,
      );
  }
}
