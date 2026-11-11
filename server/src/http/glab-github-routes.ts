/**
 * GLab の GitHub webhook の HTTP transport (spec/feature/glab-membership-github.md §6)。
 *   POST /api/glab/github/webhook  (X-Hub-Signature-256 必須)
 * 設定が無ければ 503、署名が合わなければ 401。
 * @implements SPEC-GLAB-MEMBERSHIP-GITHUB
 */
import type uWS from "uWebSockets.js";
import { AppError } from "../error.js";
import { glabRuntime } from "../glab/glab-github-runtime.js";
import { handleGithubWebhook, verifyGithubSignature } from "../glab/github-webhook.js";
import { recordGithubRepo, statusForGithubId } from "../glab/membership-store.js";

interface HttpHelpers {
  readBody(res: uWS.HttpResponse, maxBytes: number, onAborted: () => void): Promise<string>;
  jsonResponse(res: uWS.HttpResponse, status: string, data: unknown, cookies: string[], headers: Readonly<Record<string, string>>): void;
  classifyError(error: unknown): { status: string; message: string };
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function registerGlabGithubRoutes(app: uWS.TemplatedApp, http: HttpHelpers): void {
  app.post("/api/glab/github/webhook", async (res, req) => {
    const signature = req.getHeader("x-hub-signature-256");
    const event = req.getHeader("x-github-event");
    let aborted = false;
    try {
      const raw = await http.readBody(res, 1_048_576, () => { aborted = true; });
      if (aborted) return;
      const { config, client } = glabRuntime();
      if (!config?.github || !client) throw AppError.withCode(503, "github_not_configured", "GLab GitHub is not configured");
      if (!verifyGithubSignature(config.github.webhookSecret, raw, signature)) throw AppError.unauthorized("invalid webhook signature");
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { throw AppError.badRequest("Invalid JSON"); }
      const result = await handleGithubWebhook(event, payload, {
        github: config.github,
        client,
        creatorStatus: (githubId) => statusForGithubId(config.organizationId, githubId),
        record: recordGithubRepo,
      });
      if (!aborted) http.jsonResponse(res, "200 OK", result, [], NO_STORE);
    } catch (error) {
      if (aborted) return;
      const failure = http.classifyError(error);
      http.jsonResponse(res, failure.status, { error: failure.message }, [], NO_STORE);
    }
  });
}
