FROM ubuntu:24.04

# Real init and SSH; OpenShip installs the runtime and storage prerequisites.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    systemd systemd-sysv openssh-server ca-certificates curl python3 \
    iproute2 iptables kmod util-linux procps \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /root/.ssh \
    && printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\n' > /etc/ssh/sshd_config.d/openship-e2e.conf \
    && systemctl enable ssh \
    && systemctl mask systemd-networkd.service systemd-resolved.service \
    && rm -f /etc/machine-id /var/lib/dbus/machine-id
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
