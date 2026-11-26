// Full image-prompt job: label -> candidates -> AI pick -> parts -> AI write -> log.
import { buildParts, candidateScenes, severityAllowed, type SceneDb, type Severity } from "./scene-pick";

export interface PromptEnv {
  SCENES: D1Database;
  OPENROUTER_API_KEY?: string;
  LABEL_MODEL?: string;
  WRITE_MODEL?: string;
  PICK_MODEL?: string;
}

export interface StoryInput {
  news_id?: string;
  title: string;
  caption?: string;
  summary?: string;
  airline?: string;
  aircraft?: string;
  region?: string;
  dry_run?: boolean;
}

const MOODS = ["calm", "neutral", "hopeful", "celebratory", "curious", "tense", "urgent", "chaotic", "somber"];
const SEVS: Severity[] = ["low", "medium", "high"];

async function llm(env: PromptEnv, model: string, system: string, user: string, maxTokens = 900, effort = "none"): Promise<Record<string, unknown>> {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set.");
  let lastRaw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.4,
        reasoning: { effort },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      if (attempt === 1) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? "";
    lastRaw = raw || JSON.stringify(data).slice(0, 300);
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        /* retry */
      }
    }
  }
  throw new Error(`Model did not return valid JSON: ${lastRaw.slice(0, 300)}`);
}

const storyText = (s: StoryInput) =>
  `TITLE: ${s.title}\nCAPTION: ${s.caption ?? ""}\nSUMMARY: ${(s.summary ?? "").slice(0, 1500)}`;

// ---------- A. label ----------
async function label(env: PromptEnv, db: SceneDb, story: StoryInput) {
  const topics =
    ((await db.prepare("SELECT id, name, definition FROM topics ORDER BY id").bind().all<{ id: number; name: string; definition: string }>()).results ?? []);
  const list = topics.map((t) => `${t.id} | ${t.name} | ${t.definition}`).join("\n");
  const system = `You label one travel-news story for image selection. Return one JSON object only.
Fields: topic_id (integer from the list), severity ("low"|"medium"|"high"), mood (one of: ${MOODS.join(", ")}), time_of_day (only if the story states it, else ""), weather (only if the story states it, else ""), region (SEA, EAsia, SAsia, MidEast, CAsia, Oceania, Pacific, Europe, NAm, Africa, Caribbean, or "" if unclear), place_name (a real airport or landmark named in the story, else ""), suggested_topic (only if you used a general label 110-125, else "").
Rules: one topic only; read title plus summary; label a disruption by its cause, except crash (33) and runway or ground incident (36); planned schedule news stays a route topic; a probe about an incident takes that incident's topic; a new rule takes the rule's topic; a specific topic beats a broad one; mixed story = the headline's main event. Use a general label (110-125) only if no specific topic fits.
Severity: high = deaths, serious injury, crash, attack, hijack, major emergency; medium = disruption, delay, strike, security or safety issue with no harm to people; low = everything else (deals, routes, guides, business, features).
Topic list (id | name | definition):
${list}`;
  const out = await llm(env, env.LABEL_MODEL ?? "anthropic/claude-haiku-5.5", system, storyText(story), 500);
  const topicId = Number(out.topic_id);
  const known = topics.find((t) => t.id === topicId);
  const severity = SEVS.includes(String(out.severity).toLowerCase() as Severity) ? (String(out.severity).toLowerCase() as Severity) : "low";
  const mood = MOODS.includes(String(out.mood).toLowerCase()) ? String(out.mood).toLowerCase() : "neutral";
  return {
    topic_id: known ? topicId : 125,
    topic_name: known?.name ?? "General other",
    severity,
    mood: mood.charAt(0).toUpperCase() + mood.slice(1),
    time_of_day: String(out.time_of_day ?? "").trim(),
    weather: String(out.weather ?? "").trim(),
    region: String(out.region ?? "").trim() || story.region || "",
    place_name: String(out.place_name ?? "").trim(),
    suggested_topic: String(out.suggested_topic ?? "").trim(),
  };
}

// ---------- C. pick scene ----------
async function pickScene(
  env: PromptEnv,
  story: StoryInput,
  scenes: { id: number; name: string; description: string; people: string; must_not_imply: string }[],
) {
  const system = `You choose the photo scene for a news post. Return one JSON object: {"scene_id": <id or null>, "reason": "<one short sentence>"}.
Pick the scene that best fits the story. REJECT any scene whose picture would imply facts the story does not state (a cause, blame, casualties, injuries, damage, a delay, a closure, crowd size, who is helping whom, number of items). Use each scene's must_not_imply as a guide. Read the story carefully and check exactly who is affected (a passenger, a crew member, the captain, a child) and reject scenes that show a different person in that role. If none is safe, return null.`;
  const user = `${storyText(story)}\n\nCANDIDATE SCENES:\n${scenes
    .map((s) => `#${s.id} ${s.name}\n  ${s.description}\n  people: ${s.people}\n  must not imply: ${s.must_not_imply}`)
    .join("\n")}`;
  const out = await llm(env, env.PICK_MODEL ?? "anthropic/claude-sonnet-5.5", system, user, 2500, "low");
  const id = Number(out.scene_id);
  return { id: scenes.some((s) => s.id === id) ? id : null, reason: String(out.reason ?? "") };
}

// ---------- E. write prompt ----------
async function writePrompt(env: PromptEnv, story: StoryInput, pkg: Awaited<ReturnType<typeof buildParts>> & { status: 200 }) {
  const system = `You write one photographic image prompt (about 150 words, plain prose, one paragraph) for an image model. Return JSON: {"prompt": "..."}.
Order: camera and look (device, lens, framing, distance, height and angle, depth of field, shutter feel, color grade, image quality, lens flaws); the subject and action from the scene; the place and modifiers; the people (count, look, expression, pose); light and weather; the mood shown visually, never as an emotion word.
Rules: describe only what a camera would see. Use the scene description as the base; do not add facts missing from the story (no cause, blame, casualties, counts, delays). Keep to about 5 to 8 distinct props. Do not name the scene, topic or setup. Do not mention airlines or aircraft models; aircraft are plain white and unbranded. Everyone in the picture is an invented anonymous person. Where the cast lists a role, a gender or an age, use it for the main person only; other people stay generic. If the scene says hands only, show no faces. Keep light and weather coherent: if the package gives conflicting light details (for example night with sunrise, or infrared with daylight), use the time of day and drop the clashing detail. Use only elements in the package; add nothing region-specific (palms, snow, temples) unless the package says so. Screens, boards and signs are present only as unreadable blurs. Do not use these words: logo, watermark, text, cinematic, stunning, beautiful, hyper-realistic, 8k, masterpiece. Do not restate negatives in the prose; the exclusions are appended separately.`;
  const user = `STORY: ${story.title}\n${story.caption ?? ""}\n\nPACKAGE:\n${JSON.stringify(
    {
      scene: pkg.scene,
      camera: pkg.camera,
      place: pkg.place,
      modifiers: pkg.modifiers,
      cast: pkg.cast,
      cast_note: pkg.cast_note,
      mood: pkg.mood,
      severity: pkg.severity,
    },
    null,
    1,
  )}`;
  const out = await llm(env, env.WRITE_MODEL ?? env.LABEL_MODEL ?? "anthropic/claude-haiku-5.5", system, user, 700);
  let text = String(out.prompt ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 80) throw new Error("Writer returned an empty prompt.");
  const tail = [
    "Photo-realistic, ordinary photograph.",
    "No readable text, no logos, no watermarks, no overlay text.",
    "No recognizable real people.",
    pkg.severity === "high" ? "Faces turned away or too far to see." : "",
    pkg.cast_note?.includes("hands only") ? "No faces visible." : "",
    "Any aircraft are plain and unbranded.",
  ]
    .filter(Boolean)
    .join(" ");
  text = `${text} ${tail}`;
  return text;
}

export async function runPrompt(env: PromptEnv, story: StoryInput) {
  const db = env.SCENES as unknown as SceneDb;
  const lab = await label(env, db, story);

  // B. candidates (with fallback to the general label of the group, then the global general label)
  let cand = await candidateScenes(db, {
    topic_id: lab.topic_id,
    severity: lab.severity,
    limit: 12,
    airline: story.airline,
    aircraft: story.aircraft,
  });
  let usedTopic = lab.topic_id;
  if (cand.count === 0) {
    cand = await candidateScenes(db, { topic_id: 125, severity: lab.severity, limit: 12 });
    usedTopic = 125;
  }
  if (cand.count === 0) throw new Error(`No scenes for topic ${lab.topic_id} at severity ${lab.severity}.`);

  // C. AI pick
  let pick = await pickScene(env, story, cand.scenes);
  let fallback = "";
  if (pick.id == null) {
    // retry with the general label scenes, then take a random safe candidate
    fallback = "AI rejected all candidates; used a random candidate.";
    const rnd = cand.scenes[Math.floor(Math.random() * cand.scenes.length)];
    pick = { id: rnd.id, reason: fallback };
  }

  // D. parts
  const mood = lab.mood;
  let parts = await buildParts(db, {
    scene_id: pick.id!,
    topic_id: usedTopic,
    severity: lab.severity,
    mood,
    news_id: story.news_id,
    headline: story.title,
    time_of_day: lab.time_of_day || undefined,
    weather: lab.weather || undefined,
    region: lab.region || undefined,
    place_name: lab.place_name || undefined,
    dry_run: story.dry_run === true,
  });
  if ("error" in parts) {
    // mood/setup mismatch: retry with a neutral mood
    parts = await buildParts(db, {
      scene_id: pick.id!,
      topic_id: usedTopic,
      severity: lab.severity,
      mood: "Neutral",
      news_id: story.news_id,
      headline: story.title,
      time_of_day: lab.time_of_day || undefined,
      weather: lab.weather || undefined,
      region: lab.region || undefined,
      dry_run: story.dry_run === true,
    });
    if ("error" in parts) throw new Error(parts.error);
  }

  // E. write
  const prompt = await writePrompt(env, story, parts as never);
  if (parts.post_id) {
    await env.SCENES.prepare("UPDATE posts SET final_prompt = ? WHERE id = ?").bind(prompt, parts.post_id).run();
  }
  return {
    prompt,
    post_id: parts.post_id,
    topic_id: usedTopic,
    topic_name: lab.topic_name,
    severity: lab.severity,
    mood: parts.mood,
    scene_id: parts.scene.id,
    scene_name: parts.scene.name,
    setup: parts.setup,
    pick_reason: pick.reason,
    candidate_note: cand.note,
    suggested_topic: lab.suggested_topic || null,
  };
}

export { severityAllowed };
