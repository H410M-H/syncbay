// Real SshRunnerDriver run against an sshd host (here localhost:2222): dispatch, status, stop.
import { RunnerDriverFactory } from "../../src/lib/orchestrator/runner-driver";
async function main() {
  const driver: any = RunnerDriverFactory.createDriver("ssh", {
    host: "127.0.0.1", port: Number(process.env.RUNNER_SSH_PORT || 2222), username: "root",
    privateKeyPath: process.env.RUNNER_SSH_KEY_PATH,
  } as any);
  const res = await driver.dispatchBuild({ deploymentId: "dep_ssh_live", serviceId: "svc_ssh", serviceName: "sshdemo",
    hostPort: 46300, containerPort: 3000, environmentVariables: { NODE_ENV: "production" } } as any);
  console.log(res.status === "ACTIVE" ? "PASS" : "FAIL", "ssh dispatch", res.containerId?.slice(0, 12));
  await new Promise((r) => setTimeout(r, 1500));
  const http = await fetch("http://127.0.0.1:46300/health").then((r) => r.status).catch(() => 0);
  console.log(http === 200 ? "PASS" : "FAIL", "container reachable", http);
  const st = await driver.checkStatus(res.containerId);
  console.log(st.status === "ACTIVE" ? "PASS" : "FAIL", "ssh status", st.status);
  const stop = await driver.stopContainer(res.containerId);
  console.log(stop?.stopped !== false ? "PASS" : "FAIL", "ssh stop", JSON.stringify(stop).slice(0, 80));
}
main().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
