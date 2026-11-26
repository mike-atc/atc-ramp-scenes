import { runPrompt } from "./prompt";
import { buildParts, candidateScenes, type SceneDb, type Severity } from "./scene-pick";

interface Env {
  SCENES: D1Database;
  /** secret: wrangler secret put RAMP_SCENES_KEY */
  RAMP_SCENES_KEY: string;
  OPENROUTER_API_KEY?: string;
  LABEL_MODEL?: string;
  WRITE_MODEL?: string;
}

const j = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const bad = (error: string, status = 400) => j({ error }, status);
const num = (v: unknown) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * POST /pick  (Authorization: Bearer RAMP_SCENES_KEY)
 *  mode "candidates": { topic_id, severity, limit?, include_unbranded?, airline?, aircraft? }
 *  mode "build": { scene_id, severity, mood, topic_id?, news_id?, headline?, time_of_day?, weather?, region?, place_name?, dry_run? }
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return j({ ok: true });
    if (!["/pick", "/prompt", "/post-update"].includes(url.pathname) || request.method !== "POST") return bad("Not found.", 404);
    if (!env.RAMP_SCENES_KEY || request.headers.get("authorization") !== `Bearer ${env.RAMP_SCENES_KEY}`) {
      return bad("Unauthorized.", 401);
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return bad("Body must be JSON.");
    }
    if (url.pathname === "/post-update") {
      const id = Number(body.post_id);
      if (!Number.isInteger(id) || id < 1) return bad("post_id is required.");
      const imageUrl = str(body.image_url, 1000);
      const fbUrl = str(body.facebook_url, 1000);
      const status = str(body.status, 20);
      await env.SCENES.prepare(
        "UPDATE posts SET image_url = COALESCE(NULLIF(?, ''), image_url), facebook_url = COALESCE(NULLIF(?, ''), facebook_url), status = COALESCE(NULLIF(?, ''), status) WHERE id = ?",
      )
        .bind(imageUrl, fbUrl, status, id)
        .run();
      return j({ ok: true, post_id: id });
    }
    if (url.pathname === "/prompt") {
      const title = str(body.title, 400);
      if (!title) return bad("title is required.");
      try {
        return j(
          await runPrompt(env, {
            news_id: str(body.news_id, 80) || undefined,
            title,
            caption: str(body.caption, 2000),
            summary: str(body.summary, 3000),
            airline: str(body.airline, 80) || undefined,
            aircraft: str(body.aircraft, 80) || undefined,
            region: str(body.region, 20) || undefined,
            dry_run: body.dry_run === true,
          }),
        );
      } catch (e) {
        return bad(e instanceof Error ? e.message : "Prompt job failed.", 500);
      }
    }
    const severity = str(body.severity, 10).toLowerCase();
    if (!["low", "medium", "high"].includes(severity)) return bad("severity must be low, medium or high.");
    const db = env.SCENES as unknown as SceneDb;
    try {
      if (body.mode === "candidates") {
        const topic = num(body.topic_id);
        if (topic === undefined) return bad("topic_id is required.");
        return j(
          await candidateScenes(db, {
            topic_id: topic,
            severity: severity as Severity,
            limit: num(body.limit),
            include_unbranded: body.include_unbranded === true,
            airline: str(body.airline, 80) || undefined,
            aircraft: str(body.aircraft, 80) || undefined,
          }),
        );
      }
      if (body.mode === "build") {
        const sceneId = num(body.scene_id);
        const mood = str(body.mood, 30);
        if (sceneId === undefined) return bad("scene_id is required.");
        if (!mood) return bad("mood is required.");
        const r = await buildParts(db, {
          scene_id: sceneId,
          topic_id: num(body.topic_id),
          severity: severity as Severity,
          mood,
          news_id: str(body.news_id, 80) || undefined,
          headline: str(body.headline, 300) || undefined,
          time_of_day: str(body.time_of_day, 40) || undefined,
          weather: str(body.weather, 60) || undefined,
          region: str(body.region, 20) || undefined,
          place_name: str(body.place_name, 120) || undefined,
          dry_run: body.dry_run === true,
        });
        if ("error" in r) return bad(r.error as string, r.status);
        return j(r);
      }
    } catch (e) {
      return bad(e instanceof Error ? e.message : "Scene pick failed.", 500);
    }
    return bad('mode must be "candidates" or "build".');
  },
};
