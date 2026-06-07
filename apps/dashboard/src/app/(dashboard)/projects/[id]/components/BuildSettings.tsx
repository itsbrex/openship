import React, { useRef, useState } from "react";
import { ChevronDown, ChevronUp, Inbox, Layers, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import BuildSettingsComponent from "@/components/import-project/BuildSettings";

export const BuildSettings = () => {
  const { buildData, updateBuild, projectData, servicesData, id } = useProjectSettings();
  const router = useRouter();
  const isWebmail = projectData?.framework === "webmail";
  // When the project deploys via services (compose containers or monorepo
  // sub-apps), per-service build settings live on the service rows - there's
  // no single project-level "build command" to edit. The project-level form
  // would compete with the per-service config and confuse users about where
  // the source of truth lives. Show a pointer to the Services tab instead.
  const services = servicesData.services;
  const hasServices = services.length > 0;
  const monorepoCount = services.filter((s) => s.kind === "monorepo").length;
  const composeCount = services.length - monorepoCount;

  const [showEnvironment, setShowEnvironment] = useState(false);

  const [loading, setLoading] = useState({
    installCommand: false,
    buildCommand: false,
    outputDirectory: false,
    productionPaths: false,
    startCommand: false,
    productionPort: false,
    buildImage: false,
  });

  const { showToast } = useToast();

  const isLoadingRef = useRef(false);

  const handleSaveField = async (field: string, value: string) => {
    if (isLoadingRef.current) return;

    setLoading({ ...loading, [field]: true });
    isLoadingRef.current = true;

    const response = await projectsApi.setOptions(id, { [field]: value });

    if (response.success) {
      updateBuild({ [field]: value });
      showToast('Project options updated successfully', 'success', 'Updated');
    } else {
      showToast(response.message, 'error', 'Failed to update project options');
    }

    isLoadingRef.current = false;
    setLoading({ ...loading, [field]: false });
  };

  // Build a description that matches the actual service mix - no
  // generic "you have services," tell them which kinds and how many.
  const serviceLabel = (() => {
    if (monorepoCount && composeCount) {
      return `${monorepoCount} sub-app${monorepoCount === 1 ? "" : "s"} and ${composeCount} compose service${composeCount === 1 ? "" : "s"}`;
    }
    if (monorepoCount) {
      return `${monorepoCount} sub-app${monorepoCount === 1 ? "" : "s"}`;
    }
    return `${composeCount} compose service${composeCount === 1 ? "" : "s"}`;
  })();

  return (
    <div className="max-w-5xl space-y-6">
        {isWebmail ? (
          <div className="bg-card rounded-2xl border border-border/50 p-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-muted/50 border border-border/50 flex items-center justify-center shrink-0">
                <Inbox className="w-5 h-5 text-muted-foreground" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-foreground mb-1">
                  Managed by openship
                </h2>
                <p className="text-sm text-muted-foreground">
                  Webmail uses a fixed build and start pipeline. Install,
                  build, and run commands are not configurable - redeploy from
                  the mail overview to pick up upstream changes.
                </p>
              </div>
            </div>
          </div>
        ) : hasServices ? (
          // Service-based project (compose and/or monorepo). The project-level
          // build form doesn't apply - each service has its own settings on
          // the service row. Send the user to the right place instead of
          // showing a competing form that would silently no-op.
          <div className="bg-card rounded-2xl border border-border/50 p-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Layers className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold text-foreground mb-1">
                  Per-service settings
                </h2>
                <p className="text-sm text-muted-foreground mb-4">
                  This project has {serviceLabel}. Build commands, framework,
                  ports, and run commands live on each service row - edit
                  them in the Services tab.
                </p>
                <button
                  type="button"
                  onClick={() => router.push(`/projects/${id}/services`)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Open Services
                  <ArrowRight className="size-3.5" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <BuildSettingsComponent
            mode="advanced"
            buildData={buildData}
            buildConfig={{
              options: buildData,
              buildImage: buildData.buildImage,
              updateOptions: updateBuild,
              framework: projectData?.framework,
              packageManager: projectData?.packageManager,
            }}
            onSave={handleSaveField}
            loading={loading}
          />
        )}

        {/* <ServerSideSwitch
          style={{ background: '#fafafa' }}
          productionPort={buildData.productionPort}
          hasServer={buildData.hasServer}
          handleServerToggleChange={(checked: boolean) => updateBuild({ hasServer: checked })}
        /> */}
        {/* Environment Settings Toggle Button */}
        <div className="border-t border-border pt-6">
          <button
            onClick={() => setShowEnvironment(!showEnvironment)}
            className="w-full flex items-center justify-between p-4 bg-amber-500/10 rounded-xl border border-amber-500/20 transition-all group"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-500/15 rounded-xl flex items-center justify-center border border-amber-500/20">
                <svg className="w-5 h-5 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <div className="text-left">
                <h3 className="text-normal font-semibold text-foreground">Environment Variables</h3>
                <p className="text-sm text-muted-foreground">Manage your environment variables and secrets</p>
              </div>
            </div>
            {showEnvironment ? (
              <ChevronUp className="w-5 h-5 text-amber-600 dark:text-amber-400 transition-transform" />
            ) : (
              <ChevronDown className="w-5 h-5 text-amber-600 dark:text-amber-400 transition-transform" />
            )}
          </button>

          {/* Environment Settings - Hidden by default */}
          {showEnvironment && (
            <div className="mt-6 animate-in slide-in-from-top-4 duration-300">
              <EnvironmentSettings />
            </div>
          )}
        </div>
    </div>
  );
};
