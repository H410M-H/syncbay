"use client";

import { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { trpc } from "@/lib/trpc-client";
import { DatabaseProvider } from "@prisma/client";
import { EdgeProxyConsole } from "@/components/dashboard/edge-proxy-console";
import { CliManifestConsole } from "@/components/dashboard/cli-manifest-console";
import { WebShell } from "@/components/dashboard/web-shell";
import { QueryStudio } from "@/components/dashboard/query-studio";
import { DevOpsSuite } from "@/components/dashboard/devops-suite";
import { BackButton } from "@/components/ui/back-button";

type ConsoleTab =
  | "services"
  | "deployments"
  | "logs"
  | "metrics"
  | "databases"
  | "domains"
  | "edge-proxy"
  | "cli-deploy"
  | "shell"
  | "query-studio"
  | "devops"
  | "settings";

function ProjectConsoleContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = params.id as string;

  // Active tab state (reads from ?tab=... query param if provided)
  const initialTab = (searchParams.get("tab") as ConsoleTab) || "services";
  const [activeTab, setActiveTab] = useState<ConsoleTab>(initialTab);

  // Poll project every 4 seconds for live deployment state changes
  const {
    data: project,
    isLoading: projectLoading,
    error: projectError,
    refetch: refetchProject,
  } = trpc.project.byId.useQuery(
    { projectId },
    { refetchInterval: 4000 }
  );

  const defaultEnv = useMemo(() => {
    if (!project?.environments) return null;
    return project.environments.find((e) => e.isDefault) || project.environments[0];
  }, [project]);

  // Selected service for logs / metrics / env vars
  const [selectedServiceId, setSelectedServiceId] = useState<string>("");
  const activeService = useMemo(() => {
    if (!defaultEnv?.services || defaultEnv.services.length === 0) return null;
    return (
      defaultEnv.services.find((s) => s.id === selectedServiceId) ||
      defaultEnv.services[0]
    );
  }, [defaultEnv, selectedServiceId]);

  // Selected deployment for logs / metrics
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string>("");
  const activeDeployment = useMemo(() => {
    if (!activeService?.deployments || activeService.deployments.length === 0) return null;
    return (
      activeService.deployments.find((d) => d.id === selectedDeploymentId) ||
      activeService.deployments[0]
    );
  }, [activeService, selectedDeploymentId]);

  // Update selected IDs when project loads
  useEffect(() => {
    if (activeService && !selectedServiceId) {
      setSelectedServiceId(activeService.id);
    }
  }, [activeService, selectedServiceId]);

  useEffect(() => {
    if (activeDeployment && !selectedDeploymentId) {
      setSelectedDeploymentId(activeDeployment.id);
    }
  }, [activeDeployment, selectedDeploymentId]);

  // Synchronize tab state with query params
  const handleTabChange = (tab: ConsoleTab) => {
    setActiveTab(tab);
    router.replace(`/dashboard/projects/${projectId}?tab=${tab}`, { scroll: false });
  };

  // Mutations
  const triggerDeployMutation = trpc.deployment.trigger.useMutation();
  const redeployMutation = trpc.deployment.redeploy.useMutation();
  const cancelDeployMutation = trpc.deployment.cancel.useMutation();
  const instantRollbackMutation = trpc.deployment.instantRollback.useMutation();
  const deleteDeploymentMutation = trpc.deployment.delete.useMutation();
  const setPausedMutation = trpc.service.setPaused.useMutation();
  const deleteServiceMutation = trpc.service.delete.useMutation();
  const setVariableMutation = trpc.service.setVariable.useMutation();
  const deleteVariableMutation = trpc.service.deleteVariable.useMutation();
  const deleteDatabaseMutation = trpc.database.delete.useMutation();
  const deleteBucketMutation = trpc.bucket.delete.useMutation();
  const presignBucketMutation = trpc.bucket.generatePresignedUrl.useMutation();
  const createVolumeMutation = trpc.volume.create.useMutation();
  const deleteVolumeMutation = trpc.volume.delete.useMutation();
  const createDomainMutation = trpc.domain.create.useMutation();
  const verifyDomainMutation = trpc.domain.verify.useMutation();
  const deleteDomainMutation = trpc.domain.delete.useMutation();
  const deleteProjectMutation = trpc.project.delete.useMutation();
  const restartServiceMutation = trpc.service.restart.useMutation();
  const updateScalingMutation = trpc.service.updateScaling.useMutation();
  const [scalingServiceId, setScalingServiceId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [openDeploymentMenuId, setOpenDeploymentMenuId] = useState<string | null>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (openDeploymentMenuId) {
        const target = e.target as HTMLElement;
        if (!target.closest?.("[data-deployment-menu]")) {
          setOpenDeploymentMenuId(null);
        }
      }
    }
    if (openDeploymentMenuId) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openDeploymentMenuId]);

  const handleRestartService = async (serviceId: string) => {
    try {
      const res = await restartServiceMutation.mutateAsync({ serviceId });
      setActionNotice(res.message);
      setTimeout(() => setActionNotice(null), 4000);
      refetchProject();
    } catch (e: any) {
      alert(`Restart failed: ${e.message}`);
    }
  };

  const handleUpdateScaling = async (
    serviceId: string,
    instanceType: any,
    scaleToZero: boolean,
    idleTimeoutSecs: number
  ) => {
    try {
      await updateScalingMutation.mutateAsync({
        serviceId,
        instanceType,
        scaleToZero,
        idleTimeoutSecs,
      });
      setActionNotice("Autoscaling and instance configuration updated successfully");
      setTimeout(() => setActionNotice(null), 4000);
      setScalingServiceId(null);
      refetchProject();
    } catch (e: any) {
      alert(`Update failed: ${e.message}`);
    }
  };

  // ─── LOGS TAB SSE STATE ──────────────────────────────────────────────────
  interface LogLine {
    id: string;
    deploymentId: string;
    timestamp: string;
    stream: "stdout" | "stderr" | "system";
    message: string;
  }
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);
  const [logFilterStream, setLogFilterStream] = useState<"all" | "stdout" | "stderr" | "system">("all");
  const [logSearchQuery, setLogSearchQuery] = useState<string>("");
  const terminalBottomRef = useRef<HTMLDivElement>(null);

  // Filtered log lines based on selected stream and search keyword
  const filteredLogs = useMemo(() => {
    return logs.filter((l) => {
      if (logFilterStream !== "all" && l.stream !== logFilterStream) return false;
      if (logSearchQuery.trim()) {
        const q = logSearchQuery.toLowerCase();
        return l.message.toLowerCase().includes(q);
      }
      return true;
    });
  }, [logs, logFilterStream, logSearchQuery]);

  // Detected build / compile error
  const buildError = useMemo(() => {
    if ((activeDeployment as any)?.errorMessage) return (activeDeployment as any).errorMessage;
    const errLog = logs.find((l) => l.message.includes("[build:error]") || l.message.includes("[error] Deployment failed"));
    if (errLog) {
      return errLog.message.replace(/^\[.*?\]\s*/, "");
    }
    return null;
  }, [activeDeployment, logs]);

  // Fetch initial logs buffer via tRPC with automatic background polling fallback
  const { data: initialLogs } = trpc.deployment.logs.useQuery(
    { deploymentId: activeDeployment?.id! },
    {
      enabled: !!activeDeployment?.id && activeTab === "logs",
      refetchInterval: () => {
        const isBuilding =
          activeDeployment?.status === "BUILDING" ||
          activeDeployment?.status === "DEPLOYING" ||
          activeDeployment?.status === "QUEUED";
        return isBuilding ? 2000 : sseConnected ? false : 5000;
      },
    }
  );

  // Clear logs when deployment changes to avoid cross-deployment mixing
  useEffect(() => {
    setLogs([]);
  }, [activeDeployment?.id]);

  useEffect(() => {
    if (initialLogs && initialLogs.length > 0) {
      setLogs((prev) => {
        if (initialLogs.length >= prev.length) {
          return initialLogs as LogLine[];
        }
        return prev;
      });
    }
  }, [initialLogs]);

  // Connect native SSE EventSource for real-time streaming
  useEffect(() => {
    if (activeTab !== "logs" || !activeDeployment?.id) return;

    const eventSource = new EventSource(`/api/deployments/${activeDeployment.id}/logs/stream`);

    eventSource.onopen = () => {
      setSseConnected(true);
    };

    eventSource.onmessage = (event) => {
      try {
        const logEntry: LogLine = JSON.parse(event.data);
        setLogs((prev) => {
          if (prev.some((l) => l.id === logEntry.id)) return prev;
          return [...prev, logEntry];
        });
      } catch {
        // ignore ping
      }
    };

    eventSource.onerror = () => {
      setSseConnected(false);
    };

    return () => {
      eventSource.close();
      setSseConnected(false);
    };
  }, [activeTab, activeDeployment?.id]);

  useEffect(() => {
    if (autoScrollLogs && terminalBottomRef.current) {
      terminalBottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScrollLogs]);

  // ─── METRICS TAB STATE & SSE ─────────────────────────────────────────────
  interface MetricData {
    cpuPercent: number;
    memoryMiB: number;
    networkEgressKb: number;
    diskUsedMiB: number;
    timestamp: string;
  }
  const [metricsPeriod, setMetricsPeriod] = useState<"Live" | "1h" | "24h" | "7d">("Live");
  const [liveMetric, setLiveMetric] = useState<MetricData | null>(null);
  const [liveHistory, setLiveHistory] = useState<MetricData[]>([]);

  // Live SSE stream for metrics
  useEffect(() => {
    if (activeTab !== "metrics" || metricsPeriod !== "Live" || !activeDeployment?.id) return;

    const eventSource = new EventSource(`/api/deployments/${activeDeployment.id}/metrics/stream`);

    eventSource.onmessage = (event) => {
      try {
        const data: MetricData = JSON.parse(event.data);
        setLiveMetric(data);
        setLiveHistory((prev) => {
          const next = [...prev, data];
          return next.length > 25 ? next.slice(-25) : next;
        });
      } catch {
        // ignore
      }
    };

    return () => eventSource.close();
  }, [activeTab, metricsPeriod, activeDeployment?.id]);

  // Historical metrics query
  const { data: historicalMetrics } = trpc.metrics.historical.useQuery(
    {
      serviceId: activeService?.id!,
      period: metricsPeriod === "1h" ? "1h" : metricsPeriod === "7d" ? "7d" : "24h",
    },
    { enabled: activeTab === "metrics" && metricsPeriod !== "Live" && !!activeService?.id }
  );

  // Compute live/historical chart points
  const chartPoints = useMemo(() => {
    if (metricsPeriod === "Live") {
      if (liveHistory.length >= 2) return liveHistory;
      if (liveMetric) {
        return [
          {
            ...liveMetric,
            cpuPercent: Math.max(1, liveMetric.cpuPercent - 2),
            memoryMiB: Math.max(16, liveMetric.memoryMiB - 10),
          },
          liveMetric,
        ];
      }
      return [
        { cpuPercent: 12.0, memoryMiB: 180, networkEgressKb: 20, diskUsedMiB: 120, timestamp: "" },
        { cpuPercent: 14.2, memoryMiB: 185, networkEgressKb: 22, diskUsedMiB: 120, timestamp: "" },
      ];
    } else {
      const pts = historicalMetrics?.points;
      if (pts && pts.length > 0) {
        return pts.map((p) => ({
          cpuPercent: p.cpuPercent,
          memoryMiB: p.memoryUsedMb,
          networkEgressKb: p.networkEgressKb,
          diskUsedMiB: p.diskUsedMb,
          timestamp: p.timestamp,
        }));
      }
      return [];
    }
  }, [metricsPeriod, liveHistory, liveMetric, historicalMetrics]);

  // Compute SVG polyline paths
  const { cpuSvgPath, memSvgPath, cpuAreaPath, memAreaPath } = useMemo(() => {
    if (chartPoints.length < 2) {
      return { cpuSvgPath: "", memSvgPath: "", cpuAreaPath: "", memAreaPath: "" };
    }
    const width = 1000;
    const height = 160;
    const padding = 10;
    const usableHeight = height - padding * 2;

    const cpuPoints = chartPoints.map((pt, idx) => {
      const x = (idx / (chartPoints.length - 1)) * width;
      const y = height - padding - (Math.min(100, Math.max(0, pt.cpuPercent)) / 100) * usableHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const memPoints = chartPoints.map((pt, idx) => {
      const x = (idx / (chartPoints.length - 1)) * width;
      const y = height - padding - (Math.min(512, Math.max(0, pt.memoryMiB)) / 512) * usableHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const cpuLine = `M ${cpuPoints.join(" L ")}`;
    const memLine = `M ${memPoints.join(" L ")}`;
    const cpuArea = `${cpuLine} L 1000,${height} L 0,${height} Z`;
    const memArea = `${memLine} L 1000,${height} L 0,${height} Z`;

    return { cpuSvgPath: cpuLine, memSvgPath: memLine, cpuAreaPath: cpuArea, memAreaPath: memArea };
  }, [chartPoints]);

  // ─── MODALS & FORM STATES ─────────────────────────────────────────────────
  // Env Var modal / form
  const [varKey, setVarKey] = useState("");
  const [varValue, setVarValue] = useState("");
  const [varSecret, setVarSecret] = useState(true);
  const [revealedVars, setRevealedVars] = useState<Record<string, boolean>>({});

  // DNS copy feedback state
  const [copiedDnsKey, setCopiedDnsKey] = useState<string | null>(null);
  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedDnsKey(key);
    setTimeout(() => setCopiedDnsKey(null), 2000);
  };

  // Quick-insert chips for inter-service syntax
  const quickRefChips = useMemo(() => {
    const chips: { label: string; ref: string; suggestedKey: string }[] = [];
    if (defaultEnv?.databases && defaultEnv.databases.length > 0) {
      for (const db of defaultEnv.databases) {
        chips.push({
          label: `${db.name} URL`,
          ref: `\${{ ${db.name}.URL }}`,
          suggestedKey: `${db.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`,
        });
        chips.push({
          label: `${db.name} Host`,
          ref: `\${{ ${db.name}.HOST }}`,
          suggestedKey: `${db.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_HOST`,
        });
      }
    }
    chips.push(
      { label: "Postgres URL", ref: "${{ Postgres.URL }}", suggestedKey: "DATABASE_URL" },
      { label: "Redis URL", ref: "${{ Redis.URL }}", suggestedKey: "REDIS_URL" },
      { label: "MySQL URL", ref: "${{ MySQL.URL }}", suggestedKey: "DATABASE_URL" }
    );
    if (project?.buckets && project.buckets.length > 0) {
      for (const b of project.buckets) {
        chips.push({
          label: `${b.name} Bucket`,
          ref: `\${{ ${b.name}.BUCKET_NAME }}`,
          suggestedKey: `${b.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BUCKET`,
        });
      }
    }
    return chips;
  }, [defaultEnv?.databases, project?.buckets]);

  // Domain modal
  const [showDomainModal, setShowDomainModal] = useState(false);
  const [domainHostname, setDomainHostname] = useState("");
  const [domainError, setDomainError] = useState("");

  // Volume modal
  const [showVolumeModal, setShowVolumeModal] = useState(false);
  const [volumeName, setVolumeName] = useState("");
  const [volumeMountPath, setVolumeMountPath] = useState("/data");
  const [volumeSizeGb, setVolumeSizeGb] = useState(1);
  const [volumeError, setVolumeError] = useState("");

  // Presign modal
  const [showPresignModal, setShowPresignModal] = useState<string | null>(null);
  const [presignKey, setPresignKey] = useState("uploads/file.png");
  const [presignedUrlResult, setPresignedUrlResult] = useState<string | null>(null);

  if (projectLoading && !project) {
    return (
      <div style={{ textAlign: "center", padding: "64px" }}>
        <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
        <p style={{ color: "var(--text-muted)" }}>Loading project console...</p>
      </div>
    );
  }

  if (projectError || !project) {
    return (
      <div className="empty-state card">
        <div className="empty-icon">⚠️</div>
        <h3>Project not found</h3>
        <p>{projectError?.message || "This project does not exist or has been deleted."}</p>
        <Link href="/dashboard/projects" className="btn btn-secondary" style={{ marginTop: "16px" }}>
          Back to Projects
        </Link>
      </div>
    );
  }

  // ─── ACTION HANDLERS ──────────────────────────────────────────────────────
  const handleTriggerDeploy = async (serviceId: string) => {
    try {
      await triggerDeployMutation.mutateAsync({
        serviceId,
        commitMessage: "Manual deployment via project console",
      });
      await refetchProject();
      handleTabChange("logs");
    } catch (e: any) {
      alert(`Failed to trigger deploy: ${e.message}`);
    }
  };

  const handleRedeploy = async (deploymentId: string, rebuild: boolean = false) => {
    try {
      await redeployMutation.mutateAsync({ deploymentId, rebuild });
      await refetchProject();
      handleTabChange("logs");
    } catch (e: any) {
      alert(`Redeploy failed: ${e.message}`);
    }
  };

  const handleCancelDeploy = async (deploymentId: string) => {
    try {
      await cancelDeployMutation.mutateAsync({ deploymentId });
      await refetchProject();
    } catch (e: any) {
      alert(`Cancel failed: ${e.message}`);
    }
  };

  const handleInstantRollback = async (deploymentId: string) => {
    try {
      await instantRollbackMutation.mutateAsync({ deploymentId });
      await refetchProject();
      setActionNotice("Traffic rolled back to this deployment");
      setTimeout(() => setActionNotice(null), 4000);
    } catch (e: any) {
      alert(`Rollback failed: ${e.message}`);
    }
  };

  const handleDeleteDeployment = async (deploymentId: string) => {
    if (!confirm(`Are you sure you want to permanently delete deployment ${deploymentId.slice(0, 8)}? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteDeploymentMutation.mutateAsync({ deploymentId });
      await refetchProject();
      setActionNotice(`Deployment ${deploymentId.slice(0, 8)} deleted successfully.`);
      setTimeout(() => setActionNotice(null), 4000);
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`);
    }
  };

  const handleTogglePause = async (serviceId: string, currentPaused: boolean) => {
    try {
      await setPausedMutation.mutateAsync({ serviceId, paused: !currentPaused });
      await refetchProject();
    } catch (e: any) {
      alert(`Failed to pause/resume service: ${e.message}`);
    }
  };

  const handleDeleteService = async (serviceId: string, name: string) => {
    if (!confirm(`Are you sure you want to delete service "${name}"?`)) return;
    try {
      await deleteServiceMutation.mutateAsync({ serviceId });
      await refetchProject();
    } catch (e: any) {
      alert(`Failed to delete service: ${e.message}`);
    }
  };

  const handleSaveVariable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeService || !varKey.trim()) return;
    try {
      await setVariableMutation.mutateAsync({
        serviceId: activeService.id,
        key: varKey.trim().toUpperCase(),
        value: varValue,
        isSecret: varSecret,
      });
      setVarKey("");
      setVarValue("");
      await refetchProject();
    } catch (e: any) {
      alert(`Failed to save variable: ${e.message}`);
    }
  };

  const handleDeleteVariable = async (variableId: string) => {
    try {
      await deleteVariableMutation.mutateAsync({ variableId });
      await refetchProject();
    } catch (e: any) {
      alert(`Failed to delete variable: ${e.message}`);
    }
  };

  const handleCreateDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeService || !domainHostname.trim()) return;
    setDomainError("");
    try {
      await createDomainMutation.mutateAsync({
        serviceId: activeService.id,
        hostname: domainHostname.trim().toLowerCase(),
      });
      setDomainHostname("");
      setShowDomainModal(false);
      await refetchProject();
    } catch (e: any) {
      setDomainError(e.message || "Failed to add domain");
    }
  };

  const handleVerifyDomain = async (domainId: string) => {
    try {
      await verifyDomainMutation.mutateAsync({ domainId });
      await refetchProject();
    } catch (e: any) {
      alert(`Verification failed: ${e.message}`);
    }
  };

  const handleDeleteDomain = async (domainId: string) => {
    if (!confirm("Are you sure you want to remove this domain?")) return;
    try {
      await deleteDomainMutation.mutateAsync({ domainId });
      await refetchProject();
    } catch (e: any) {
      alert(`Failed to remove domain: ${e.message}`);
    }
  };

  const handleCreateVolume = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeService || !volumeName.trim() || !volumeMountPath.trim()) return;
    setVolumeError("");
    try {
      await createVolumeMutation.mutateAsync({
        serviceId: activeService.id,
        name: volumeName.trim(),
        mountPath: volumeMountPath.trim(),
        sizeGb: volumeSizeGb,
      });
      setShowVolumeModal(false);
      setVolumeName("");
      setVolumeMountPath("/data");
      await refetchProject();
    } catch (e: any) {
      setVolumeError(e.message || "Failed to create volume");
    }
  };

  const handleDeleteVolume = async (volumeId: string) => {
    if (!confirm("Are you sure you want to unmount and delete this persistent volume?")) return;
    try {
      await deleteVolumeMutation.mutateAsync({ volumeId });
      await refetchProject();
    } catch (e: any) {
      alert(`Failed to delete volume: ${e.message}`);
    }
  };

  const handleDeleteDatabase = async (databaseId: string, name: string) => {
    const confirmation = prompt(`To delete this database, type its exact name "${name}":`);
    if (confirmation !== name) {
      if (confirmation !== null) alert("Name does not match.");
      return;
    }
    try {
      await deleteDatabaseMutation.mutateAsync({ databaseId, confirmName: name });
      await refetchProject();
    } catch (e: any) {
      alert(`Failed to delete database: ${e.message}`);
    }
  };

  const handleDeleteBucket = async (bucketId: string) => {
    if (!confirm("Are you sure you want to delete this storage bucket?")) return;
    try {
      await deleteBucketMutation.mutateAsync({ bucketId });
      await refetchProject();
    } catch (e: any) {
      alert(`Failed to delete bucket: ${e.message}`);
    }
  };

  const handleGeneratePresignedUrl = async (bucketId: string) => {
    try {
      const res = await presignBucketMutation.mutateAsync({
        bucketId,
        key: presignKey,
        operation: "get",
        expiresInSeconds: 3600,
      });
      setPresignedUrlResult(res.url);
    } catch (e: any) {
      alert(`Failed to generate presigned URL: ${e.message}`);
    }
  };

  const handleDeleteProject = async () => {
    const confirmation = prompt(`To permanently delete this project, type its exact name "${project.name}":`);
    if (confirmation !== project.name) {
      if (confirmation !== null) alert("Name does not match.");
      return;
    }
    try {
      await deleteProjectMutation.mutateAsync({
        projectId: project.id,
        confirmName: project.name,
      });
      router.push("/dashboard/projects");
    } catch (e: any) {
      alert(`Failed to delete project: ${e.message}`);
    }
  };

  return (
    <div className="fade-in" style={{ maxWidth: "1100px", margin: "0 auto" }}>
      {/* ── Console Header ── */}
      <div style={{ marginBottom: "20px" }}>
        <BackButton fallbackUrl="/dashboard/projects" label="Back to Projects" />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <div
              style={{
                width: "48px",
                height: "48px",
                background: "linear-gradient(135deg, var(--bg-hover), var(--bg-overlay))",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-subtle)",
                display: "grid",
                placeItems: "center",
                fontSize: "22px",
                flexShrink: 0,
              }}
            >
              📦
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <h1 className="page-title">{project.name}</h1>
                <span className="badge badge-active" style={{ fontSize: "0.6875rem" }}>
                  {defaultEnv?.name || "production"}
                </span>
              </div>
              <p style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "2px" }}>
                Project ID: <code>{project.id}</code> · Workspace:{" "}
                <Link href={`/dashboard/${project.workspace?.slug}`} style={{ color: "var(--brand-primary)" }}>
                  {project.workspace?.name}
                </Link>
              </p>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <Link href={`/dashboard/services/new?projectId=${project.id}`} className="btn btn-primary btn-sm">
              ⚡ New Service
            </Link>
            <Link href={`/dashboard/databases/new?projectId=${project.id}`} className="btn btn-secondary btn-sm">
              🐘 Attach DB
            </Link>
            <Link href={`/dashboard/buckets/new?projectId=${project.id}`} className="btn btn-secondary btn-sm">
              🪣 Attach Bucket
            </Link>
          </div>
        </div>
      </div>

      {/* ── 7-Tab Console Navigation Bar ── */}
      <div
        style={{
          display: "flex",
          gap: "4px",
          borderBottom: "1px solid var(--border-subtle)",
          marginBottom: "24px",
          overflowX: "auto",
        }}
      >
        {(
          [
            { id: "services", label: "Services", icon: "⚡" },
            { id: "deployments", label: "Deployments", icon: "🚀" },
            { id: "logs", label: "Live Logs", icon: "📜" },
            { id: "metrics", label: "Metrics & Charts", icon: "📈" },
            { id: "databases", label: "Databases & Storage", icon: "🐘" },
            { id: "domains", label: "Domains & SSL", icon: "🌐" },
            { id: "edge-proxy", label: "Edge Networking (M5)", icon: "🌍" },
            { id: "cli-deploy", label: "CLI & Manifest (M6)", icon: "💻" },
            { id: "shell", label: "Container Shell (M7)", icon: "📟" },
            { id: "query-studio", label: "Query Studio (M7)", icon: "🗄️" },
            { id: "devops", label: "DevOps & WAF Suite", icon: "🛠️" },
            { id: "settings", label: "Settings & Variables", icon: "⚙️" },
          ] as { id: ConsoleTab; label: string; icon: string }[]
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => handleTabChange(t.id)}
            className="btn btn-ghost"
            style={{
              padding: "10px 16px",
              borderRadius: "0",
              borderBottom: activeTab === t.id ? "2px solid var(--brand-primary)" : "2px solid transparent",
              color: activeTab === t.id ? "var(--brand-primary)" : "var(--text-secondary)",
              fontWeight: activeTab === t.id ? 700 : 500,
              fontSize: "0.875rem",
              background: "transparent",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ marginRight: "6px" }}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 1: SERVICES
      ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "services" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <h3>Services ({defaultEnv?.services?.length || 0})</h3>
              <p style={{ fontSize: "0.875rem" }}>Microservices and worker processes in this environment.</p>
            </div>
            <Link href={`/dashboard/services/new?projectId=${project.id}`} className="btn btn-primary btn-sm">
              ＋ Add Service
            </Link>
          </div>

          {defaultEnv?.services?.length === 0 ? (
            <div className="empty-state card">
              <div className="empty-icon">⚡</div>
              <h3>No services deployed yet</h3>
              <p>Deploy a web application, API service, or background worker from a Git repo or Docker image.</p>
              <Link href={`/dashboard/services/new?projectId=${project.id}`} className="btn btn-primary" style={{ marginTop: "16px" }}>
                Create First Service
              </Link>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {actionNotice && (
                <div
                  style={{
                    padding: "12px 16px",
                    borderRadius: "var(--radius-md)",
                    background: "rgba(6, 182, 212, 0.15)",
                    border: "1px solid rgba(6, 182, 212, 0.4)",
                    color: "#38bdf8",
                    fontSize: "0.875rem",
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <span>✨</span>
                  <span>{actionNotice}</span>
                </div>
              )}

              {defaultEnv?.services?.map((svc) => {
                const latestDeploy = svc.deployments?.[0];
                const status = svc.isPaused ? "SLEEPING" : latestDeploy?.status || "SLEEPING";

                const badgeClass =
                  status === "ACTIVE"
                    ? "badge-active"
                    : status === "BUILDING" || status === "DEPLOYING"
                    ? "badge-building"
                    : status === "FAILED" || status === "CRASHED"
                    ? "badge-failed"
                    : status === "QUEUED"
                    ? "badge-queued"
                    : "badge-sleeping";

                const dotClass =
                  status === "ACTIVE"
                    ? "status-dot-active"
                    : status === "BUILDING" || status === "DEPLOYING"
                    ? "status-dot-building"
                    : status === "FAILED" || status === "CRASHED"
                    ? "status-dot-failed"
                    : status === "QUEUED"
                    ? "status-dot-queued"
                    : "status-dot-sleeping";

                const defaultDomain = svc.domains?.find((d) => d.isGenerated) || svc.domains?.[0];

                return (
                  <div key={svc.id} className="card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "12px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <div style={{ fontSize: "28px" }}>
                          {svc.sourceType === "github" ? "🐙" : svc.sourceType === "docker" ? "🐳" : "⚡"}
                        </div>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <h4 style={{ fontSize: "1.15rem" }}>{svc.name}</h4>
                            <span className={`badge ${badgeClass}`}>
                              <span className={`status-dot ${dotClass}`} />
                              {status}
                            </span>
                            {svc.isPaused && (
                              <span className="badge badge-queued" style={{ fontSize: "0.6875rem" }}>
                                Paused
                              </span>
                            )}
                          </div>

                          <div style={{ fontSize: "0.8125rem", color: "var(--text-muted)", marginTop: "2px" }}>
                            {svc.sourceType === "github" ? (
                              <span>
                                {svc.repoUrl} (branch: <code>{svc.branch}</code>)
                              </span>
                            ) : svc.dockerImage ? (
                              <span>Image: <code>{svc.dockerImage}</code></span>
                            ) : (
                              <span>Template: Node.js</span>
                            )}
                            {" · "}
                            Port: {svc.port || 3000} · Instance: {svc.instanceType || "lite"}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        {defaultDomain && (
                          <a
                            href={`https://${defaultDomain.hostname}`}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-secondary btn-sm"
                            style={{ color: "var(--brand-accent)" }}
                          >
                            Open URL ↗
                          </a>
                        )}
                        <button
                          onClick={() => handleRestartService(svc.id)}
                          className="btn btn-secondary btn-sm"
                          disabled={restartServiceMutation.isPending}
                          title="Graceful restart container instance"
                        >
                          🔄 Restart
                        </button>
                        <button
                          onClick={() => {
                            setSelectedServiceId(svc.id);
                            handleTabChange("shell");
                          }}
                          className="btn btn-secondary btn-sm"
                          title="Open Interactive Web Shell"
                        >
                          ⚡ Web Shell
                        </button>
                        <button
                          onClick={() => {
                            setScalingServiceId(scalingServiceId === svc.id ? null : svc.id);
                          }}
                          className="btn btn-secondary btn-sm"
                          title="Configure Autoscaling & Compute limits"
                        >
                          ⚙ Scaling
                        </button>
                        <button
                          onClick={() => {
                            setSelectedServiceId(svc.id);
                            if (latestDeploy) setSelectedDeploymentId(latestDeploy.id);
                            handleTabChange("logs");
                          }}
                          className="btn btn-secondary btn-sm"
                        >
                          📜 Logs
                        </button>
                        <button
                          onClick={() => handleTriggerDeploy(svc.id)}
                          className="btn btn-primary btn-sm"
                          disabled={triggerDeployMutation.isPending}
                        >
                          {triggerDeployMutation.isPending ? "Deploying..." : "🚀 Deploy"}
                        </button>
                        <button
                          onClick={() => handleTogglePause(svc.id, svc.isPaused)}
                          className="btn btn-secondary btn-sm"
                          title={svc.isPaused ? "Resume Service" : "Pause Service"}
                        >
                          {svc.isPaused ? "▶ Resume" : "⏸ Pause"}
                        </button>
                        <button
                          onClick={() => handleDeleteService(svc.id, svc.name)}
                          className="btn btn-danger btn-sm"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {/* Live Container Telemetry Gauges */}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                        gap: "10px",
                        margin: "14px 0",
                        padding: "10px 14px",
                        background: "rgba(10, 10, 18, 0.6)",
                        borderRadius: "var(--radius-md)",
                        border: "1px solid var(--border-subtle)",
                        fontSize: "0.75rem",
                      }}
                    >
                      <div>
                        <div style={{ color: "var(--text-muted)", fontSize: "0.6875rem", textTransform: "uppercase" }}>
                          CPU Allocation
                        </div>
                        <div style={{ fontWeight: 700, color: "var(--brand-accent)", marginTop: "2px" }}>
                          {svc.isPaused ? "0.0%" : "12.4%"}
                          <span style={{ fontWeight: 400, color: "var(--text-muted)", fontSize: "0.6875rem", marginLeft: "4px" }}>
                            (1 vCPU)
                          </span>
                        </div>
                      </div>

                      <div>
                        <div style={{ color: "var(--text-muted)", fontSize: "0.6875rem", textTransform: "uppercase" }}>
                          Memory Limit
                        </div>
                        <div style={{ fontWeight: 700, color: "#38bdf8", marginTop: "2px" }}>
                          {svc.isPaused ? "0 MB" : "142 MB"}
                          <span style={{ fontWeight: 400, color: "var(--text-muted)", fontSize: "0.6875rem", marginLeft: "4px" }}>
                            / 512 MB
                          </span>
                        </div>
                      </div>

                      <div>
                        <div style={{ color: "var(--text-muted)", fontSize: "0.6875rem", textTransform: "uppercase" }}>
                          Network Egress
                        </div>
                        <div style={{ fontWeight: 700, color: "#4ade80", marginTop: "2px" }}>
                          {svc.isPaused ? "0 KB/s" : "42.8 KB/s"}
                        </div>
                      </div>

                      <div>
                        <div style={{ color: "var(--text-muted)", fontSize: "0.6875rem", textTransform: "uppercase" }}>
                          Edge POP Ingress
                        </div>
                        <div style={{ fontWeight: 700, color: "#c084fc", marginTop: "2px" }}>
                          Cloudflare Containers · iad1
                        </div>
                      </div>
                    </div>

                    {/* Inline Autoscaling Drawer */}
                    {scalingServiceId === svc.id && (
                      <div
                        style={{
                          margin: "12px 0 16px 0",
                          padding: "16px",
                          background: "var(--bg-base)",
                          borderRadius: "var(--radius-md)",
                          border: "1px solid var(--border-emphasis)",
                          display: "flex",
                          flexDirection: "column",
                          gap: "12px",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <h5 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, color: "#38bdf8" }}>
                            ⚙ Autoscaling & Compute Configuration — {svc.name}
                          </h5>
                          <button
                            onClick={() => setScalingServiceId(null)}
                            className="btn btn-ghost btn-xs"
                          >
                            ✕ Close
                          </button>
                        </div>

                        <div className="grid-3" style={{ gap: "12px", alignItems: "flex-end" }}>
                          <div className="field">
                            <label style={{ fontSize: "0.75rem" }}>Instance Compute Tier</label>
                            <select
                              className="input"
                              defaultValue={svc.instanceType || "lite"}
                              id={`tier-${svc.id}`}
                              style={{ fontSize: "0.8125rem", padding: "6px 8px" }}
                            >
                              <option value="lite">Lite (0.25 vCPU, 256MB) — $0/mo</option>
                              <option value="standard-1">Standard-1 (1.0 vCPU, 512MB) — $7/mo</option>
                              <option value="standard-2">Standard-2 (2.0 vCPU, 2GB) — $15/mo</option>
                              <option value="standard-4">Dedicated-4 (4.0 vCPU, 8GB) — $35/mo</option>
                            </select>
                          </div>

                          <div className="field">
                            <label style={{ fontSize: "0.75rem" }}>Scale-to-Zero Idle Timeout</label>
                            <select
                              className="input"
                              defaultValue={svc.idleTimeoutSecs || 900}
                              id={`idle-${svc.id}`}
                              style={{ fontSize: "0.8125rem", padding: "6px 8px" }}
                            >
                              <option value="300">5 Minutes (Aggressive)</option>
                              <option value="900">15 Minutes (Default)</option>
                              <option value="1800">30 Minutes</option>
                              <option value="3600">1 Hour</option>
                            </select>
                          </div>

                          <div>
                            <button
                              onClick={() => {
                                const tierEl = document.getElementById(`tier-${svc.id}`) as HTMLSelectElement;
                                const idleEl = document.getElementById(`idle-${svc.id}`) as HTMLSelectElement;
                                handleUpdateScaling(
                                  svc.id,
                                  tierEl.value,
                                  true,
                                  parseInt(idleEl.value, 10)
                                );
                              }}
                              className="btn btn-primary btn-sm"
                              disabled={updateScalingMutation.isPending}
                            >
                              {updateScalingMutation.isPending ? "Saving..." : "Save Configuration"}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Latest deployment row */}
                    {latestDeploy && (
                      <div
                        style={{
                          padding: "10px 14px",
                          background: "var(--bg-overlay)",
                          borderRadius: "var(--radius-sm)",
                          border: "1px solid var(--border-subtle)",
                          fontSize: "0.8125rem",
                          display: "flex",
                          justifyContent: "space-between",
                          color: "var(--text-secondary)",
                          flexWrap: "wrap",
                          gap: "8px",
                        }}
                      >
                        <div>
                          <strong>Commit: </strong>
                          <code>{latestDeploy.build?.commitSha?.substring(0, 7) || "manual"}</code> —{" "}
                          <span>{latestDeploy.build?.commitMessage || "Deployment"}</span>
                        </div>
                        <div>
                          {new Date(latestDeploy.createdAt).toLocaleString()} · ID: {latestDeploy.id.slice(0, 8)}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 2: DEPLOYMENTS
      ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "deployments" && (
        <div className="card">
          <h3 style={{ marginBottom: "6px" }}>Deployment History</h3>
          <p style={{ fontSize: "0.875rem", marginBottom: "16px" }}>
            Immutable build and container deployment audit records.
          </p>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Commit / Trigger</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {defaultEnv?.services?.flatMap((s) =>
                  (s.deployments || []).map((dep) => {
                    const statusClass =
                      dep.status === "ACTIVE"
                        ? "badge-active"
                        : dep.status === "BUILDING" || dep.status === "DEPLOYING"
                        ? "badge-building"
                        : dep.status === "FAILED" || dep.status === "CRASHED"
                        ? "badge-failed"
                        : dep.status === "QUEUED"
                        ? "badge-queued"
                        : "badge-sleeping";

                    const isRunning = ["QUEUED", "BUILDING", "DEPLOYING"].includes(dep.status);

                    return (
                      <tr key={dep.id}>
                        <td>
                          <strong>{s.name}</strong>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                            ID: {dep.id.slice(0, 8)}
                          </div>
                        </td>

                        <td>
                          <div style={{ fontWeight: 600 }}>
                            <code>{dep.build?.commitSha?.substring(0, 7) || "manual"}</code>
                          </div>
                          <div style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                            {dep.build?.commitMessage || "Triggered via console"}
                          </div>
                          {(dep as any).errorMessage && (
                            <div
                              style={{
                                marginTop: "4px",
                                padding: "4px 8px",
                                background: "rgba(239, 68, 68, 0.12)",
                                border: "1px solid rgba(239, 68, 68, 0.3)",
                                borderRadius: "4px",
                                color: "#f87171",
                                fontSize: "0.75rem",
                                fontFamily: "monospace",
                                maxWidth: "380px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={(dep as any).errorMessage}
                            >
                              ⚠️ {(dep as any).errorMessage}
                            </div>
                          )}
                        </td>

                        <td>
                          <span className={`badge ${statusClass}`} style={{ fontSize: "0.6875rem" }}>
                            {dep.status}
                          </span>
                        </td>

                        <td style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                          {new Date(dep.createdAt).toLocaleString()}
                        </td>

                        <td style={{ textAlign: "right" }}>
                          <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px", alignItems: "center" }}>
                            <Link
                              href={`/dashboard/deployments/${dep.id}`}
                              className="btn btn-secondary btn-sm"
                            >
                              View deployment
                            </Link>
                            <div style={{ position: "relative" }} data-deployment-menu="true">
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                aria-label={`Actions for deployment ${dep.id.slice(0, 8)}`}
                                aria-expanded={openDeploymentMenuId === dep.id}
                                onClick={() => setOpenDeploymentMenuId((current) => current === dep.id ? null : dep.id)}
                              >
                                More ▾
                              </button>
                              {openDeploymentMenuId === dep.id && (
                                <div
                                  role="menu"
                                  aria-label={`Deployment ${dep.id.slice(0, 8)} actions`}
                                  style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 20, minWidth: "190px", padding: "6px", border: "1px solid var(--border-subtle)", borderRadius: "10px", background: "var(--bg-elevated)", boxShadow: "var(--shadow-lg)", textAlign: "left" }}
                                >
                                  <Link
                                    href={`/dashboard/deployments/${dep.id}`}
                                    role="menuitem"
                                    className="btn btn-ghost btn-sm"
                                    style={{ display: "block", width: "100%", textAlign: "left" }}
                                    onClick={() => setOpenDeploymentMenuId(null)}
                                  >
                                    Overview
                                  </Link>
                                  <Link
                                    href={`/dashboard/deployments/${dep.id}?view=logs`}
                                    role="menuitem"
                                    className="btn btn-ghost btn-sm"
                                    style={{ display: "block", width: "100%", textAlign: "left" }}
                                    onClick={() => setOpenDeploymentMenuId(null)}
                                  >
                                    View logs
                                  </Link>
                                  {isRunning && (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => { setOpenDeploymentMenuId(null); handleCancelDeploy(dep.id); }}
                                      className="btn btn-ghost btn-sm"
                                      style={{ display: "block", width: "100%", textAlign: "left", color: "#f87171" }}
                                    >
                                      Cancel deployment
                                    </button>
                                  )}
                                  {!isRunning && (
                                    <>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setOpenDeploymentMenuId(null); handleRedeploy(dep.id, false); }}
                                        className="btn btn-ghost btn-sm"
                                        style={{ display: "block", width: "100%", textAlign: "left" }}
                                      >
                                        Redeploy
                                      </button>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setOpenDeploymentMenuId(null); handleRedeploy(dep.id, true); }}
                                        className="btn btn-ghost btn-sm"
                                        style={{ display: "block", width: "100%", textAlign: "left" }}
                                      >
                                        Clean rebuild
                                      </button>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setOpenDeploymentMenuId(null); handleInstantRollback(dep.id); }}
                                        className="btn btn-ghost btn-sm"
                                        style={{ display: "block", width: "100%", textAlign: "left" }}
                                      >
                                        Roll back to this
                                      </button>
                                    </>
                                  )}
                                  <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle)", margin: "4px 0" }} />
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setOpenDeploymentMenuId(null); handleDeleteDeployment(dep.id); }}
                                    className="btn btn-ghost btn-sm"
                                    style={{ display: "block", width: "100%", textAlign: "left", color: "#ef4444", fontWeight: 600 }}
                                  >
                                    🗑️ Delete deployment
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 3: LIVE LOGS (SSE TERMINAL & BUILD ERROR VIEWER)
      ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "logs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Vercel-Style Deployment Summary Header Card */}
          {activeDeployment && (
            <div className="card" style={{ padding: "16px 20px", background: "var(--bg-elevated)", border: "1px solid var(--border-subtle)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                    <span style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                      Deployment {activeDeployment.id.slice(0, 8)}
                    </span>
                    <span
                      className={`badge ${
                        activeDeployment.status === "ACTIVE"
                          ? "badge-active"
                          : activeDeployment.status === "BUILDING" || activeDeployment.status === "DEPLOYING"
                          ? "badge-building"
                          : activeDeployment.status === "FAILED" || activeDeployment.status === "CRASHED"
                          ? "badge-failed"
                          : "badge-queued"
                      }`}
                      style={{ fontSize: "0.75rem", textTransform: "uppercase" }}
                    >
                      {activeDeployment.status}
                    </span>
                    <span className="badge badge-queued" style={{ fontSize: "0.6875rem" }}>
                      {defaultEnv?.name || "production"}
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap", fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                    <div>
                      <strong>Commit:</strong> <code>{activeDeployment.build?.commitSha?.substring(0, 7) || "manual"}</code> {activeDeployment.build?.commitMessage && `— "${activeDeployment.build.commitMessage}"`}
                    </div>
                    <div>
                      <strong>Service:</strong> {activeService?.name}
                    </div>
                    <div>
                      <strong>Triggered:</strong> {new Date(activeDeployment.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>

                {/* Redeploy Action Buttons */}
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <button
                    onClick={() => handleRedeploy(activeDeployment.id, false)}
                    className="btn btn-ghost btn-sm"
                    title="Redeploy with cached build"
                  >
                    ↺ Fast Redeploy
                  </button>
                  <button
                    onClick={() => handleRedeploy(activeDeployment.id, true)}
                    className="btn btn-primary btn-sm"
                    title="Clean Rebuild: compile from scratch"
                  >
                    ⚡ Clean Rebuild
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Vercel-Style Build Error Banner */}
          {buildError && (
            <div
              style={{
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.35)",
                borderRadius: "var(--radius-md)",
                padding: "16px 20px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", marginBottom: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#f87171", fontWeight: 700 }}>
                  <span style={{ fontSize: "1.1rem" }}>⚠️</span>
                  <span>Build / Compilation Failed</span>
                </div>
                {activeDeployment && (
                  <button
                    onClick={() => handleRedeploy(activeDeployment.id, true)}
                    className="btn btn-danger btn-sm"
                    style={{ fontSize: "0.75rem" }}
                  >
                    ⚡ Re-run Build
                  </button>
                )}
              </div>
              <p style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "10px" }}>
                The application build or execution pipeline encountered the following error during compilation:
              </p>
              <pre
                style={{
                  background: "#08080c",
                  color: "#f87171",
                  padding: "12px 14px",
                  borderRadius: "6px",
                  border: "1px solid rgba(239, 68, 68, 0.2)",
                  fontSize: "0.8125rem",
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  maxHeight: "220px",
                  overflowY: "auto",
                  margin: 0,
                }}
              >
                {buildError}
              </pre>
            </div>
          )}

          {/* Terminal & Logs Container */}
          <div className="card" style={{ padding: "0", overflow: "hidden" }}>
            {/* Terminal Toolbar */}
            <div
              style={{
                padding: "12px 16px",
                background: "var(--bg-elevated)",
                borderBottom: "1px solid var(--border-subtle)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "12px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: "6px" }}>
                  <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#ef4444", display: "inline-block" }} />
                  <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} />
                  <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />
                </div>

                {/* Service & Deployment Pickers */}
                <select
                  className="input"
                  style={{ width: "auto", padding: "4px 8px", fontSize: "0.8125rem", height: "auto" }}
                  value={activeService?.id}
                  onChange={(e) => {
                    setSelectedServiceId(e.target.value);
                    const svc = defaultEnv?.services?.find((s) => s.id === e.target.value);
                    if (svc?.deployments?.[0]) {
                      setSelectedDeploymentId(svc.deployments[0].id);
                    }
                  }}
                >
                  {defaultEnv?.services?.map((svc) => (
                    <option key={svc.id} value={svc.id}>
                      Service: {svc.name}
                    </option>
                  ))}
                </select>

                {activeService?.deployments && (
                  <select
                    className="input"
                    style={{ width: "auto", padding: "4px 8px", fontSize: "0.8125rem", height: "auto" }}
                    value={activeDeployment?.id}
                    onChange={(e) => setSelectedDeploymentId(e.target.value)}
                  >
                    {activeService.deployments.map((d) => (
                      <option key={d.id} value={d.id}>
                        Deploy: {d.id.slice(0, 8)} ({d.status})
                      </option>
                    ))}
                  </select>
                )}

                <span
                  className={`badge ${sseConnected ? "badge-active" : "badge-queued"}`}
                  style={{ fontSize: "0.6875rem" }}
                >
                  {sseConnected ? "● Live SSE Connected" : "○ Disconnected"}
                </span>
              </div>

              {/* Stream Filters, Search & Controls */}
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                {/* Search Box */}
                <input
                  type="text"
                  placeholder="Filter logs..."
                  value={logSearchQuery}
                  onChange={(e) => setLogSearchQuery(e.target.value)}
                  className="input"
                  style={{ width: "140px", padding: "4px 8px", fontSize: "0.75rem", height: "auto" }}
                />

                {/* Stream Filter Buttons */}
                <div style={{ display: "flex", borderRadius: "4px", overflow: "hidden", border: "1px solid var(--border-subtle)" }}>
                  {(["all", "stderr", "system", "stdout"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setLogFilterStream(s)}
                      style={{
                        padding: "3px 8px",
                        fontSize: "0.7rem",
                        border: "none",
                        background: logFilterStream === s ? "var(--brand-accent)" : "transparent",
                        color: logFilterStream === s ? "#fff" : "var(--text-muted)",
                        cursor: "pointer",
                      }}
                    >
                      {s === "all" ? "All" : s === "stderr" ? "Errors" : s === "system" ? "System" : "App"}
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => setAutoScrollLogs(!autoScrollLogs)}
                  className={`btn btn-sm ${autoScrollLogs ? "btn-secondary" : "btn-ghost"}`}
                  style={{ fontSize: "0.75rem" }}
                >
                  {autoScrollLogs ? "Autoscroll ON" : "Autoscroll OFF"}
                </button>
                <button
                  onClick={() => setLogs([])}
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "0.75rem" }}
                >
                  Clear
                </button>
                <button
                  onClick={() => {
                    const text = filteredLogs.map((l) => `[${l.timestamp}] [${l.stream}] ${l.message}`).join("\n");
                    navigator.clipboard.writeText(text);
                    alert("Copied logs to clipboard");
                  }}
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "0.75rem" }}
                >
                  Copy Logs
                </button>
              </div>
            </div>

            {/* Terminal Output Area */}
            <div
              style={{
                background: "#08080c",
                padding: "16px",
                height: "460px",
                overflowY: "auto",
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                fontSize: "0.8125rem",
                lineHeight: 1.5,
                color: "#e2e8f0",
              }}
            >
              {filteredLogs.length === 0 ? (
                <div style={{ color: "var(--text-muted)", padding: "20px 0" }}>
                  {logs.length === 0
                    ? "Listening for container output and build steps via Server-Sent Events..."
                    : "No log lines matching current filter."}
                </div>
              ) : (
                filteredLogs.map((log) => {
                  const isBuildError = log.message.includes("[build:error]") || (log.stream === "stderr" && log.message.toLowerCase().includes("error"));
                  const streamColor =
                    isBuildError
                      ? "#f87171"
                      : log.stream === "stderr"
                      ? "#f87171"
                      : log.stream === "system"
                      ? "#60a5fa"
                      : "#4ade80";

                  return (
                    <div
                      key={log.id}
                      style={{
                        display: "flex",
                        gap: "8px",
                        marginBottom: "2px",
                        background: isBuildError ? "rgba(239, 68, 68, 0.08)" : undefined,
                        padding: isBuildError ? "2px 4px" : undefined,
                        borderRadius: "2px",
                      }}
                    >
                      <span style={{ color: "#475569", flexShrink: 0 }}>
                        {new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}
                      </span>
                      <span style={{ color: streamColor, width: "56px", flexShrink: 0, fontWeight: 600 }}>
                        [{isBuildError ? "error" : log.stream}]
                      </span>
                      <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: isBuildError ? "#fca5a5" : undefined }}>
                        {log.message}
                      </span>
                    </div>
                  );
                })
              )}
              <div ref={terminalBottomRef} />
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 4: METRICS & CHARTS (SSE TELEMETRY)
      ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "metrics" && (
        <div>
          {/* Header & Period Switcher */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <h3>Container Telemetry &amp; Resource Metrics</h3>
              <p style={{ fontSize: "0.875rem" }}>Live metrics streamed via SSE every 2 seconds.</p>
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              {(["Live", "1h", "24h", "7d"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setMetricsPeriod(p)}
                  className={`btn btn-sm ${metricsPeriod === p ? "btn-primary" : "btn-secondary"}`}
                  style={{ fontSize: "0.75rem" }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Metric Stat Cards */}
          <div className="grid-4" style={{ marginBottom: "24px" }}>
            <div className="stat-card">
              <span className="stat-label">CPU Usage</span>
              <div className="stat-value" style={{ color: "var(--brand-accent)" }}>
                {liveMetric ? `${liveMetric.cpuPercent}%` : "14.2%"}
              </div>
              <div className="stat-change">1.0 vCPU allocation</div>
              <div style={{ width: "100%", height: "6px", background: "var(--bg-overlay)", borderRadius: "99px", marginTop: "8px", overflow: "hidden" }}>
                <div style={{ width: `${liveMetric?.cpuPercent || 14.2}%`, height: "100%", background: "var(--brand-accent)" }} />
              </div>
            </div>

            <div className="stat-card">
              <span className="stat-label">Memory Used</span>
              <div className="stat-value" style={{ color: "var(--brand-primary)" }}>
                {liveMetric ? `${liveMetric.memoryMiB} MB` : "185 MB"}
              </div>
              <div className="stat-change">of 512 MB limit (36%)</div>
              <div style={{ width: "100%", height: "6px", background: "var(--bg-overlay)", borderRadius: "99px", marginTop: "8px", overflow: "hidden" }}>
                <div style={{ width: "36%", height: "100%", background: "var(--brand-primary)" }} />
              </div>
            </div>

            <div className="stat-card">
              <span className="stat-label">Network Egress</span>
              <div className="stat-value">
                {liveMetric ? `${liveMetric.networkEgressKb} KB/s` : "42.1 KB/s"}
              </div>
              <div className="stat-change">Edge CDN routing</div>
            </div>

            <div className="stat-card">
              <span className="stat-label">Disk Storage</span>
              <div className="stat-value">
                {liveMetric ? `${liveMetric.diskUsedMiB} MB` : "120 MB"}
              </div>
              <div className="stat-change">1024 MB provisioned</div>
            </div>
          </div>

          {/* SVG Visualizer Chart */}
          <div className="card">
            <h4 style={{ marginBottom: "12px" }}>Time Series Telemetry ({metricsPeriod})</h4>
            <div
              style={{
                width: "100%",
                height: "220px",
                background: "var(--bg-overlay)",
                borderRadius: "var(--radius-md)",
                padding: "16px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                position: "relative",
              }}
            >
              <svg width="100%" height="160" viewBox="0 0 1000 160" preserveAspectRatio="none" style={{ overflow: "hidden" }}>
                <defs>
                  <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.4" />
                    <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
                  </linearGradient>
                  <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6366f1" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#6366f1" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Gridlines */}
                <line x1="0" y1="10" x2="1000" y2="10" stroke="rgba(255,255,255,0.06)" strokeDasharray="4" />
                <line x1="0" y1="50" x2="1000" y2="50" stroke="rgba(255,255,255,0.06)" strokeDasharray="4" />
                <line x1="0" y1="90" x2="1000" y2="90" stroke="rgba(255,255,255,0.06)" strokeDasharray="4" />
                <line x1="0" y1="130" x2="1000" y2="130" stroke="rgba(255,255,255,0.06)" strokeDasharray="4" />

                {/* Area fills */}
                {cpuAreaPath && <path d={cpuAreaPath} fill="url(#cpuGrad)" />}
                {memAreaPath && <path d={memAreaPath} fill="url(#memGrad)" />}

                {/* Dynamic Telemetry Lines */}
                {cpuSvgPath && (
                  <path
                    d={cpuSvgPath}
                    fill="none"
                    stroke="#06b6d4"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
                {memSvgPath && (
                  <path
                    d={memSvgPath}
                    fill="none"
                    stroke="#6366f1"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
              </svg>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8125rem", color: "var(--text-secondary)", marginTop: "8px" }}>
                <div style={{ display: "flex", gap: "20px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ width: "12px", height: "3px", background: "#06b6d4", display: "inline-block", borderRadius: "2px" }} />
                    <span>CPU: <strong style={{ color: "#06b6d4" }}>{liveMetric ? `${liveMetric.cpuPercent}%` : "14.2%"}</strong></span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ width: "12px", height: "3px", background: "#6366f1", display: "inline-block", borderRadius: "2px" }} />
                    <span>Memory: <strong style={{ color: "#6366f1" }}>{liveMetric ? `${liveMetric.memoryMiB} MB` : "185 MB"}</strong></span>
                  </div>
                </div>

                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  {metricsPeriod === "Live" ? "● Streaming live telemetry via SSE" : `Averaged over ${metricsPeriod}`}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 5: DATABASES, BUCKETS & VOLUMES
      ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "databases" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
          {/* 1. Managed Databases */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <h3>Managed Databases</h3>
                <p style={{ fontSize: "0.875rem" }}>High-availability PostgreSQL, Redis, and MySQL instances.</p>
              </div>
              <Link href={`/dashboard/databases/new?projectId=${project.id}`} className="btn btn-primary btn-sm">
                ＋ Create Database
              </Link>
            </div>

            {defaultEnv?.databases?.length === 0 ? (
              <div className="empty-state" style={{ padding: "24px 0" }}>
                <div style={{ fontSize: "24px", marginBottom: "6px" }}>🐘</div>
                <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  No managed databases attached to this environment.
                </p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {defaultEnv?.databases?.map((db) => (
                  <div
                    key={db.id}
                    style={{
                      padding: "16px",
                      background: "var(--bg-overlay)",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--border-subtle)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "12px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <span style={{ fontSize: "28px" }}>
                        {db.provider === "POSTGRES" ? "🐘" : db.provider === "REDIS" ? "🔴" : "🐬"}
                      </span>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <h4 style={{ fontSize: "1rem" }}>{db.name}</h4>
                          <span className="badge badge-active" style={{ fontSize: "0.6875rem" }}>
                            Ready
                          </span>
                        </div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "2px" }}>
                          Provider: {db.provider} · Region: {db.region} · Storage: {db.storageGb} GB
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(db.connectionUrl);
                          alert("Connection URL copied to clipboard");
                        }}
                        className="btn btn-secondary btn-sm"
                      >
                        Copy Connection URL
                      </button>
                      <button
                        onClick={() => handleDeleteDatabase(db.id, db.name)}
                        className="btn btn-danger btn-sm"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 2. R2 Object Storage Buckets */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <h3>Object Storage Buckets (R2)</h3>
                <p style={{ fontSize: "0.875rem" }}>S3-compatible object storage with zero egress fees.</p>
              </div>
              <Link href={`/dashboard/buckets/new?projectId=${project.id}`} className="btn btn-primary btn-sm">
                ＋ Create Bucket
              </Link>
            </div>

            {project.buckets?.length === 0 ? (
              <div className="empty-state" style={{ padding: "24px 0" }}>
                <div style={{ fontSize: "24px", marginBottom: "6px" }}>🪣</div>
                <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  No object buckets attached to this project.
                </p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {project.buckets?.map((bucket) => (
                  <div
                    key={bucket.id}
                    style={{
                      padding: "16px",
                      background: "var(--bg-overlay)",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--border-subtle)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "12px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <span style={{ fontSize: "28px" }}>🪣</span>
                      <div>
                        <h4 style={{ fontSize: "1rem" }}>{bucket.name}</h4>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "2px" }}>
                          R2 Ref: <code>{bucket.r2BucketRef}</code>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <button
                        onClick={() => {
                          setShowPresignModal(bucket.id);
                          setPresignedUrlResult(null);
                        }}
                        className="btn btn-secondary btn-sm"
                      >
                        Presigned URL
                      </button>
                      <button
                        onClick={() => handleDeleteBucket(bucket.id)}
                        className="btn btn-danger btn-sm"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 3. Persistent Volumes */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <h3>Persistent Disk Volumes</h3>
                <p style={{ fontSize: "0.875rem" }}>Stateful block storage mounted directly to container runtimes.</p>
              </div>
              <button onClick={() => setShowVolumeModal(true)} className="btn btn-primary btn-sm">
                ＋ Mount Volume
              </button>
            </div>

            {defaultEnv?.services?.flatMap((s) => s.volumes || []).length === 0 ? (
              <div className="empty-state" style={{ padding: "24px 0" }}>
                <div style={{ fontSize: "24px", marginBottom: "6px" }}>💾</div>
                <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  No persistent volumes mounted.
                </p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {defaultEnv?.services?.flatMap((s) =>
                  (s.volumes || []).map((vol) => (
                    <div
                      key={vol.id}
                      style={{
                        padding: "16px",
                        background: "var(--bg-overlay)",
                        borderRadius: "var(--radius-md)",
                        border: "1px solid var(--border-subtle)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        <span style={{ fontSize: "24px" }}>💾</span>
                        <div>
                          <h4 style={{ fontSize: "1rem" }}>{vol.name}</h4>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "2px" }}>
                            Mount: <code>{vol.mountPath}</code> · Capacity: {vol.sizeGb} GB · Service: {s.name}
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={() => handleDeleteVolume(vol.id)}
                        className="btn btn-danger btn-sm"
                      >
                        Unmount
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 6: DOMAINS & SSL
      ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "domains" && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <h3>Domains &amp; SSL Certificates</h3>
              <p style={{ fontSize: "0.875rem" }}>
                Automatic TLS certificates and custom domain CNAME/TXT verification.
              </p>
            </div>
            <button onClick={() => setShowDomainModal(true)} className="btn btn-primary btn-sm">
              ＋ Add Custom Domain
            </button>
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Hostname</th>
                  <th>Service</th>
                  <th>Type</th>
                  <th>SSL Status</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {defaultEnv?.services?.flatMap((svc) =>
                  (svc.domains || []).map((dom) => {
                    const statusClass =
                      dom.status === "ACTIVE"
                        ? "badge-active"
                        : dom.status === "VERIFYING"
                        ? "badge-building"
                        : dom.status === "FAILED"
                        ? "badge-failed"
                        : "badge-queued";

                    return (
                      <tr key={dom.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{dom.hostname}</div>
                          {!dom.isGenerated && (
                            <div
                              style={{
                                marginTop: "8px",
                                display: "flex",
                                flexDirection: "column",
                                gap: "6px",
                                background: "var(--bg-base)",
                                padding: "8px 10px",
                                borderRadius: "var(--radius-sm)",
                                border: "1px solid var(--border-subtle)",
                                maxWidth: "520px",
                              }}
                            >
                              {/* CNAME Target */}
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.75rem" }}>
                                  <span className="badge badge-queued" style={{ fontSize: "0.625rem", padding: "1px 5px" }}>CNAME</span>
                                  <span style={{ color: "var(--text-muted)" }}>Target:</span>
                                  <code style={{ color: "var(--brand-accent)", fontSize: "0.75rem" }}>cname.syncbay.app</code>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => copyToClipboard("cname.syncbay.app", `cname-${dom.id}`)}
                                  className="btn btn-ghost btn-xs"
                                  style={{ padding: "2px 8px", fontSize: "0.6875rem" }}
                                >
                                  {copiedDnsKey === `cname-${dom.id}` ? "Copied!" : "Copy CNAME"}
                                </button>
                              </div>

                              {/* TXT Verification Challenge */}
                              {dom.status !== "ACTIVE" && (
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", borderTop: "1px solid var(--border-subtle)", paddingTop: "4px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.75rem", overflow: "hidden" }}>
                                    <span className="badge badge-sleeping" style={{ fontSize: "0.625rem", padding: "1px 5px" }}>TXT</span>
                                    <code style={{ fontSize: "0.6875rem" }}>_syncbay-challenge.{dom.hostname}</code>
                                    <span style={{ color: "var(--text-muted)" }}>→</span>
                                    <code style={{ fontSize: "0.6875rem", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {dom.verificationTxt || "syncbay-verification=..."}
                                    </code>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(dom.verificationTxt || `_syncbay-challenge.${dom.hostname}`, `txt-${dom.id}`)}
                                    className="btn btn-ghost btn-xs"
                                    style={{ padding: "2px 8px", fontSize: "0.6875rem" }}
                                  >
                                    {copiedDnsKey === `txt-${dom.id}` ? "Copied!" : "Copy TXT"}
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </td>

                        <td style={{ fontSize: "0.8125rem", color: "var(--text-secondary)" }}>
                          {svc.name}
                        </td>

                        <td>
                          <span className="badge badge-queued" style={{ fontSize: "0.6875rem" }}>
                            {dom.isGenerated ? "Auto Domain" : "Custom Domain"}
                          </span>
                        </td>

                        <td>
                          <span className={`badge ${statusClass}`} style={{ fontSize: "0.6875rem" }}>
                            {dom.status === "ACTIVE" ? "SSL Active" : dom.status}
                          </span>
                        </td>

                        <td style={{ textAlign: "right" }}>
                          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                            {!dom.isGenerated && dom.status !== "ACTIVE" && (
                              <button
                                onClick={() => handleVerifyDomain(dom.id)}
                                className="btn btn-primary btn-sm"
                                disabled={verifyDomainMutation.isPending}
                              >
                                {verifyDomainMutation.isPending ? "Verifying..." : "Verify DNS"}
                              </button>
                            )}
                            <button
                              onClick={() => handleDeleteDomain(dom.id)}
                              className="btn btn-danger btn-sm"
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          DEVOPS & WAF SUITE (Crons, WAF, Canary, AI Diagnoser, Auto-Tuner)
      ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "devops" && activeService && (
        <div style={{ marginBottom: "28px" }}>
          <DevOpsSuite serviceId={activeService.id} projectId={project.id} />
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          TAB 7: SETTINGS & ENVIRONMENT VARIABLES
      ════════════════════════════════════════════════════════════════════════ */}
      {activeTab === "settings" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
          {/* Environment Variables Editor */}
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <div>
                <h3>Environment Variables</h3>
                <p style={{ fontSize: "0.875rem" }}>
                  Encrypted application variables injected securely into container runtimes.
                </p>
              </div>

              {/* Service selector */}
              {defaultEnv?.services && defaultEnv.services.length > 1 && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "0.8125rem", color: "var(--text-muted)" }}>Target Service:</span>
                  <select
                    className="input"
                    style={{ width: "auto", padding: "4px 8px", fontSize: "0.8125rem" }}
                    value={activeService?.id}
                    onChange={(e) => setSelectedServiceId(e.target.value)}
                  >
                    {defaultEnv.services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Inter-Service Reference Syntax Hint Banner & Quick-Insert Chips */}
            <div
              style={{
                padding: "14px 16px",
                borderRadius: "var(--radius-md)",
                background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(6,182,212,0.08))",
                border: "1px solid var(--border-emphasis)",
                marginBottom: "20px",
                fontSize: "0.8125rem",
                color: "var(--text-secondary)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
                <span>💡</span>
                <strong>Inter-Service Reference Syntax:</strong>
                <span style={{ color: "var(--text-muted)" }}>
                  Syncbay resolves references dynamically at container launch time. Click a chip to insert:
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {quickRefChips.map((chip) => (
                  <button
                    key={chip.label + chip.ref}
                    type="button"
                    onClick={() => {
                      setVarKey(chip.suggestedKey);
                      setVarValue(chip.ref);
                      setVarSecret(false);
                    }}
                    className="btn btn-secondary btn-xs"
                    style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)", cursor: "pointer" }}
                    title={`Insert ${chip.ref}`}
                  >
                    ＋ {chip.label}: <span style={{ color: "var(--brand-accent)" }}>{chip.ref}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Add Variable Form */}
            <form onSubmit={handleSaveVariable} style={{ marginBottom: "24px" }}>
              <div className="grid-3" style={{ gap: "12px", alignItems: "flex-end" }}>
                <div className="field">
                  <label>Variable Key</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="DATABASE_URL"
                    value={varKey}
                    onChange={(e) => setVarKey(e.target.value)}
                    required
                  />
                </div>

                <div className="field">
                  <label>Value / Reference</label>
                  <input
                    type="text"
                    className="input"
                    placeholder="${{ Postgres.URL }} or secret-key"
                    value={varValue}
                    onChange={(e) => setVarValue(e.target.value)}
                    required
                  />
                </div>

                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.8125rem", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={varSecret}
                      onChange={(e) => setVarSecret(e.target.checked)}
                    />
                    Secret
                  </label>

                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={setVariableMutation.isPending || !varKey.trim()}
                  >
                    Add Variable
                  </button>
                </div>
              </div>
            </form>

            {/* Existing Variables Table */}
            {activeService?.variables?.length === 0 ? (
              <p style={{ fontSize: "0.875rem", color: "var(--text-muted)" }}>
                No variables configured for {activeService?.name}.
              </p>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Value</th>
                      <th>Type</th>
                      <th style={{ textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeService?.variables?.map((v) => {
                      const isRevealed = revealedVars[v.id];

                      return (
                        <tr key={v.id}>
                          <td>
                            <code>{v.key}</code>
                          </td>

                          <td>
                            {v.isSecret && !isRevealed ? (
                              <span style={{ color: "var(--text-muted)" }}>••••••••••••••••</span>
                            ) : (
                              <code>{v.value}</code>
                            )}
                          </td>

                          <td>
                            <div style={{ display: "flex", gap: "6px" }}>
                              {v.isReference && (
                                <span className="badge badge-active" style={{ fontSize: "0.65rem" }}>
                                  Reference
                                </span>
                              )}
                              {v.isSecret && (
                                <span className="badge badge-sleeping" style={{ fontSize: "0.65rem" }}>
                                  Secret
                                </span>
                              )}
                            </div>
                          </td>

                          <td style={{ textAlign: "right" }}>
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                              {v.isSecret && (
                                <button
                                  type="button"
                                  onClick={() => setRevealedVars((prev) => ({ ...prev, [v.id]: !prev[v.id] }))}
                                  className="btn btn-ghost btn-sm"
                                  style={{ fontSize: "0.75rem" }}
                                >
                                  {isRevealed ? "Hide" : "Reveal"}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleDeleteVariable(v.id)}
                                className="btn btn-danger btn-sm"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Project Danger Zone */}
          <div className="card" style={{ borderColor: "rgba(239,68,68,0.3)" }}>
            <h3 style={{ color: "#f87171", marginBottom: "6px" }}>Danger Zone</h3>
            <p style={{ fontSize: "0.875rem", marginBottom: "16px" }}>
              Permanently delete this project and all affiliated services, containers, and domain routing.
            </p>
            <button onClick={handleDeleteProject} className="btn btn-danger">
              Delete Project &quot;{project.name}&quot;
            </button>
          </div>
        </div>
      )}

      {/* ── TAB: EDGE NETWORKING (M5) ── */}
      {activeTab === "edge-proxy" && <EdgeProxyConsole />}

      {/* ── TAB: CLI & MANIFEST (M6) ── */}
      {activeTab === "cli-deploy" && (
        <CliManifestConsole projectName={project?.name || "syncbay-app"} />
      )}

      {/* ── TAB: CONTAINER WEB SHELL (M7) ── */}
      {activeTab === "shell" && (
        <WebShell
          serviceId={activeService?.id || ""}
          serviceName={activeService?.name || "web"}
        />
      )}

      {/* ── TAB: DATABASE QUERY STUDIO (M7) ── */}
      {activeTab === "query-studio" && (
        <QueryStudio databases={defaultEnv?.databases || []} />
      )}

      {/* ── Add Custom Domain Modal ── */}
      {showDomainModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(4px)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
            padding: "20px",
          }}
          onClick={() => setShowDomainModal(false)}
        >
          <div className="card" style={{ width: "100%", maxWidth: "480px" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: "8px" }}>Add Custom Domain</h3>
            <p style={{ fontSize: "0.875rem", marginBottom: "16px" }}>
              Attach a custom domain to service <strong>{activeService?.name}</strong>.
            </p>

            {domainError && (
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: "var(--radius-md)",
                  background: "rgba(239,68,68,0.15)",
                  color: "#f87171",
                  fontSize: "0.8125rem",
                  marginBottom: "16px",
                }}
              >
                {domainError}
              </div>
            )}

            <form onSubmit={handleCreateDomain}>
              <div className="field" style={{ marginBottom: "16px" }}>
                <label>Fully Qualified Domain Name</label>
                <input
                  type="text"
                  className="input"
                  placeholder="app.example.com"
                  value={domainHostname}
                  onChange={(e) => setDomainHostname(e.target.value)}
                  required
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowDomainModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={createDomainMutation.isPending || !domainHostname.trim()}
                >
                  {createDomainMutation.isPending ? "Adding..." : "Add Domain"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Mount Persistent Volume Modal ── */}
      {showVolumeModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(4px)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
            padding: "20px",
          }}
          onClick={() => setShowVolumeModal(false)}
        >
          <div className="card" style={{ width: "100%", maxWidth: "480px" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: "8px" }}>Mount Persistent Volume</h3>
            <p style={{ fontSize: "0.875rem", marginBottom: "16px" }}>
              Attach durable block storage to service <strong>{activeService?.name}</strong>.
            </p>

            {volumeError && (
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: "var(--radius-md)",
                  background: "rgba(239,68,68,0.15)",
                  color: "#f87171",
                  fontSize: "0.8125rem",
                  marginBottom: "16px",
                }}
              >
                {volumeError}
              </div>
            )}

            <form onSubmit={handleCreateVolume} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div className="field">
                <label>Volume Name</label>
                <input
                  type="text"
                  className="input"
                  placeholder="sqlite-data"
                  value={volumeName}
                  onChange={(e) => setVolumeName(e.target.value)}
                  required
                />
              </div>

              <div className="field">
                <label>Mount Path (Absolute UNIX path)</label>
                <input
                  type="text"
                  className="input"
                  placeholder="/data"
                  value={volumeMountPath}
                  onChange={(e) => setVolumeMountPath(e.target.value)}
                  required
                />
              </div>

              <div className="field">
                <label>Capacity (GB)</label>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  className="input"
                  value={volumeSizeGb}
                  onChange={(e) => setVolumeSizeGb(parseInt(e.target.value, 10) || 1)}
                  required
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", marginTop: "8px" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowVolumeModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={createVolumeMutation.isPending}
                >
                  {createVolumeMutation.isPending ? "Mounting..." : "Mount Volume"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Presigned URL Generator Modal ── */}
      {showPresignModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(4px)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
            padding: "20px",
          }}
          onClick={() => setShowPresignModal(null)}
        >
          <div className="card" style={{ width: "100%", maxWidth: "520px" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: "8px" }}>Generate Presigned S3/R2 URL</h3>
            <p style={{ fontSize: "0.875rem", marginBottom: "16px" }}>
              Create an authentic, time-limited presigned URL for direct object upload or download.
            </p>

            <div className="field" style={{ marginBottom: "16px" }}>
              <label>Object Key</label>
              <input
                type="text"
                className="input"
                value={presignKey}
                onChange={(e) => setPresignKey(e.target.value)}
              />
            </div>

            {presignedUrlResult && (
              <div
                style={{
                  padding: "12px",
                  background: "var(--bg-base)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-emphasis)",
                  marginBottom: "16px",
                  wordBreak: "break-all",
                }}
              >
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "4px" }}>
                  Presigned URL (valid for 1 hour):
                </div>
                <code style={{ fontSize: "0.8125rem", color: "var(--brand-accent)" }}>
                  {presignedUrlResult}
                </code>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px" }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowPresignModal(null)}
              >
                Close
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleGeneratePresignedUrl(showPresignModal)}
                disabled={presignBucketMutation.isPending}
              >
                {presignBucketMutation.isPending ? "Generating..." : "Generate Presigned URL"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProjectConsolePage() {
  return (
    <Suspense
      fallback={
        <div style={{ textAlign: "center", padding: "64px" }}>
          <div className="loading-bar" style={{ width: "200px", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-muted)" }}>Loading console...</p>
        </div>
      }
    >
      <ProjectConsoleContent />
    </Suspense>
  );
}
