// Scene picking from the ramp-db scene library (D1 binding SCENES).
// Step B (candidates) and step D (parts) of the new image flow.
// The AI picks the scene between the two calls; see docs/scene-pick.md.

export interface SceneDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

export type Severity = "low" | "medium" | "high";
const SEV_ORDER: Severity[] = ["low", "medium", "high"];

export interface SceneRow {
  id: number;
  name: string;
  topics: string;
  severity: string;
  shot_type: string;
  shot_type_alt: string | null;
  subject: string;
  description: string;
  place_type: string;
  people: string;
  refs: string;
  must_not_imply: string;
  setups: string;
  tags: string;
  story_blanks: string;
  weight: number;
}

interface OptionRow {
  id: number;
  category: string;
  value: string;
  tags: string;
  weight: number;
}

// ---------- small helpers ----------

export function parseList(value: string | null | undefined, sep: RegExp): string[] {
  return (value ?? "")
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const sceneTags = (v: string | null | undefined) => parseList(v, /,/).map((t) => t.toLowerCase());
export const optionTags = (v: string | null | undefined) => parseList(v, /;/).map((t) => t.toLowerCase());

export function sceneSetupIds(row: Pick<SceneRow, "setups">): number[] {
  return parseList(row.setups, /,/)
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

/** Severity ranges like "low", "low-medium", "low-high" -> allowed set. */
export function severityAllowed(range: string, severity: Severity): boolean {
  const parts = range
    .toLowerCase()
    .split("-")
    .map((s) => s.trim())
    .filter((s): s is Severity => SEV_ORDER.includes(s as Severity));
  if (!parts.length) return false;
  const lo = SEV_ORDER.indexOf(parts[0]);
  const hi = SEV_ORDER.indexOf(parts[parts.length - 1]);
  const at = SEV_ORDER.indexOf(severity);
  return at >= Math.min(lo, hi) && at <= Math.max(lo, hi);
}

export function weightedPick<T extends { weight?: number }>(items: T[], rnd: () => number = Math.random): T | null {
  if (!items.length) return null;
  const total = items.reduce((s, i) => s + Math.max(1, i.weight ?? 1), 0);
  let r = rnd() * total;
  for (const item of items) {
    r -= Math.max(1, item.weight ?? 1);
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

export function weightedShuffle<T extends { weight?: number }>(items: T[], rnd: () => number = Math.random): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (pool.length) {
    const pick = weightedPick(pool, rnd)!;
    out.push(pick);
    pool.splice(pool.indexOf(pick), 1);
  }
  return out;
}

const pickOne = <T>(items: T[], rnd: () => number = Math.random): T | null =>
  items.length ? items[Math.floor(rnd() * items.length)] : null;

// ---------- step B: candidate scenes ----------

export interface CandidateInput {
  topic_id: number;
  severity: Severity;
  limit?: number;
  /** include scenes that need airline/aircraft references even if none are stored (they render unbranded) */
  include_unbranded?: boolean;
  airline?: string;
  aircraft?: string;
}

export const COOLDOWN_POSTS = 50;

async function recentSceneIds(db: SceneDb): Promise<number[]> {
  const res = await db
    .prepare("SELECT scene_id FROM posts WHERE scene_id IS NOT NULL ORDER BY created_at DESC LIMIT ?")
    .bind(COOLDOWN_POSTS)
    .all<{ scene_id: number }>();
  return (res.results ?? []).map((r) => r.scene_id);
}

function needsRefs(scene: SceneRow): boolean {
  const tags = sceneTags(scene.tags);
  return (scene.refs ?? "none").trim().toLowerCase() !== "none" || tags.includes("ref");
}

async function hasReferences(db: SceneDb, airline?: string, aircraft?: string): Promise<boolean> {
  if (!airline && !aircraft) return false;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM reference_images
       WHERE active = 1 AND (? = '' OR LOWER(airline) = LOWER(?)) AND (? = '' OR LOWER(aircraft) = LOWER(?))`,
    )
    .bind(airline ?? "", airline ?? "", aircraft ?? "", aircraft ?? "")
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

async function scenesForTopic(db: SceneDb, topicId: number): Promise<SceneRow[]> {
  const res = await db
    .prepare("SELECT * FROM scenes WHERE active = 1 AND topics LIKE ?")
    .bind(`%,${topicId},%`)
    .all<SceneRow>();
  return res.results ?? [];
}

export async function candidateScenes(db: SceneDb, input: CandidateInput, rnd: () => number = Math.random) {
  const limit = Math.min(20, Math.max(3, input.limit ?? 12));
  const recent = new Set(await recentSceneIds(db));
  const refsOk = await hasReferences(db, input.airline, input.aircraft);

  const usable = (s: SceneRow) => {
    if (!severityAllowed(s.severity, input.severity)) return false;
    // High severity is never branded, so an aircraft scene is fine unbranded there.
    if (needsRefs(s) && !refsOk && !input.include_unbranded && input.severity !== "high") return false;
    return true;
  };

  let pool = (await scenesForTopic(db, input.topic_id)).filter(usable);
  let fresh = pool.filter((s) => !recent.has(s.id));
  let note: string | null = null;

  if (fresh.length < 4) {
    // 1) general label of the topic's group
    const topic = await db
      .prepare("SELECT group_name FROM topics WHERE id = ?")
      .bind(input.topic_id)
      .first<{ group_name: string }>();
    if (topic) {
      const general = await db
        .prepare("SELECT id FROM topics WHERE id BETWEEN 110 AND 125 AND group_name = ?")
        .bind(topic.group_name)
        .first<{ id: number }>();
      if (general && general.id !== input.topic_id) {
        const extra = (await scenesForTopic(db, general.id)).filter(usable).filter((s) => !recent.has(s.id));
        fresh = [...fresh, ...extra.filter((s) => !fresh.some((f) => f.id === s.id))];
        if (extra.length) note = `Added general-label scenes (topic ${general.id}).`;
      }
    }
  }
  if (fresh.length < 4) {
    // 2) reuse the least recently used scenes of the topic
    const order = [...recent]; // newest first
    const reuse = pool
      .filter((s) => recent.has(s.id) && !fresh.some((f) => f.id === s.id))
      .sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id)); // oldest use first
    fresh = [...fresh, ...reuse].slice(0, Math.max(4, fresh.length));
    note = (note ? note + " " : "") + "Reused least recently used scenes.";
  }

  const chosen = weightedShuffle(fresh, rnd).slice(0, limit);
  return {
    count: chosen.length,
    note,
    scenes: chosen.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      people: s.people,
      shot_type: s.shot_type,
      shot_type_alt: s.shot_type_alt,
      subject: s.subject,
      must_not_imply: s.must_not_imply,
      story_blanks: s.story_blanks,
      needs_references: needsRefs(s),
    })),
  };
}

// ---------- step D: parts ----------

export interface BuildInput {
  scene_id: number;
  topic_id?: number;
  severity: Severity;
  mood: string;
  news_id?: string;
  headline?: string;
  time_of_day?: string;
  weather?: string;
  region?: string; // SEA, EAsia, SAsia, MidEast, CAsia, Oceania, Pacific, Europe, NAm, Africa, Caribbean
  place_name?: string; // a real place named in the story
  post_date?: string; // ISO date
  dry_run?: boolean; // true = do not write the posts row
}

const POSITIVE_MOODS = new Set(["calm", "neutral", "hopeful", "celebratory", "curious"]);

/** Setups that must never be used at a given severity (from the setup rules). */
const SETUP_BLOCK: Record<Severity, number[]> = {
  low: [],
  medium: [5, 17],
  high: [5, 10, 11, 13, 17, 18],
};

const GENERIC_TIMES = ["Sunrise", "Morning", "Midday", "Afternoon", "Golden hour", "Sunset", "Blue hour", "Night"];
const GENERIC_WEATHER = ["Clear", "Partly cloudy", "Overcast", "Light rain", "Haze or smog", "Humid tropical", "Wet ground after rain"];

function listFromSetup(value: string | null | undefined, generic: string[]): string[] {
  const items = parseList(value, /;/);
  if (!items.length || /^all\b/i.test(items[0])) return generic;
  return items;
}

const SHOT_DISTANCE: Record<string, string[]> = {
  wide: ["medium", "far", "very far", "extreme"],
  medium: ["close", "medium"],
  "close-up": ["close"],
  detail: ["close"],
  aerial: ["medium", "far", "very far", "extreme"],
  exterior: ["medium", "far", "very far"],
};

export function fitDistance(options: string[], shots: string[]): string[] {
  const allowed = new Set(shots.flatMap((s) => SHOT_DISTANCE[s.toLowerCase()] ?? []));
  if (!allowed.size) return options;
  const fit = options.filter((o) => [...allowed].some((a) => o.toLowerCase().startsWith(a)));
  return fit.length ? fit : options;
}

export function fitFraming(options: string[], shots: string[]): string[] {
  const lower = shots.map((s) => s.toLowerCase());
  const tight = lower.every((s) => s === "detail" || s === "close-up");
  const wide = lower.every((s) => ["wide", "aerial", "exterior"].includes(s));
  const fit = options.filter((o) => {
    const l = o.toLowerCase();
    if (tight && l.includes("wide establishing")) return false;
    if (wide && l.includes("tight crop")) return false;
    return true;
  });
  return fit.length ? fit : options;
}

function compass(value: string | null | undefined, rnd: () => number): string {
  const v = value ?? "";
  const numbers = (v.match(/\d+/g) ?? []).map(Number);
  if (/any/i.test(v)) return `${Math.floor(rnd() * 360)} degrees`;
  if (/only \(front, sides, rear\)/i.test(v) || /0°, 90°/.test(v)) return `${pickOne([0, 90, 180, 270], rnd)} degrees`;
  if (/forward/i.test(v)) return `${(360 + Math.floor(rnd() * 61) - 30) % 360} degrees (forward)`;
  if (/fixed/i.test(v)) return v;
  return numbers.length ? v : `${Math.floor(rnd() * 360)} degrees`;
}

export async function recentPostValues(db: SceneDb, limit = 20) {
  const res = await db
    .prepare("SELECT setup_id, place_id, cast_ids, modifier_ids FROM posts ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<{ setup_id: number | null; place_id: number | null; cast_ids: string | null; modifier_ids: string | null }>();
  const rows = res.results ?? [];
  return {
    setups: rows.slice(0, 8).map((r) => r.setup_id).filter((n): n is number => n != null),
    cast: new Set(rows.flatMap((r) => parseList(r.cast_ids, /,/))),
    modifiers: new Set(rows.flatMap((r) => parseList(r.modifier_ids, /,/))),
  };
}

const CAST_PLACE_CONTEXT = ["air", "apron", "cab", "cockpit", "road", "hotel", "out"];

function sceneContexts(scene: SceneRow): string[] {
  const t = sceneTags(scene.tags);
  const ctx: string[] = [];
  if (t.includes("hall")) ctx.push("air");
  if (t.includes("apron")) ctx.push("apron", "air");
  if (t.includes("cab")) ctx.push("cab");
  if (t.includes("out")) ctx.push("out");
  if (t.includes("dash") || t.includes("road")) ctx.push("road");
  return ctx;
}

export function optionAllowed(
  opt: Pick<OptionRow, "tags">,
  ctx: { severity: Severity; mood: string; contexts: string[]; weather: string; recent: Set<string>; id: number },
): boolean {
  const tags = optionTags(opt.tags);
  if (ctx.recent.has(String(ctx.id))) return false;
  if (ctx.severity === "high" && !tags.includes("h")) return false;
  const positive = POSITIVE_MOODS.has(ctx.mood.toLowerCase());
  if (tags.includes("p") && (!positive || ctx.severity === "high")) return false;
  if (tags.includes("kids") && (!positive || ctx.severity !== "low")) return false;
  const placeTags = tags.filter((t) => CAST_PLACE_CONTEXT.includes(t));
  if (placeTags.length && ctx.contexts.length && !placeTags.some((t) => ctx.contexts.includes(t))) return false;
  if (tags.includes("rain") && !/rain|storm|wet/i.test(ctx.weather)) return false;
  if (tags.includes("cold") && !/cold|snow|winter|freez/i.test(ctx.weather)) return false;
  if (tags.includes("ref")) return false; // needs airline reference images (not available yet)
  return true;
}

/** Score a staff/group option against the scene text; best match wins. */
function groupScore(value: string, sceneText: string): number {
  const tokens = value
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 4 && !["with", "staff", "crew"].includes(t));
  return tokens.filter((t) => sceneText.includes(t.replace(/s$/, ""))).length;
}

async function pickCast(db: SceneDb, scene: SceneRow, input: BuildInput, weather: string, recent: Set<string>, rnd: () => number) {
  const people = (scene.people ?? "none").toLowerCase();
  if (people.startsWith("none")) return { cast: null as null | Record<string, string>, ids: [] as number[], note: "no people" };

  const handsOnly = /\bhands?\b|\bfeet\b|\bthumb|\bpairs of hands\b/.test(people) && !/crew|agent|handlers|staff|passenger|traveler/.test(people);
  const crowd = scene.subject === "Crowd" || /crowd|\d+-\d+ people/.test(people);
  const staff =
    sceneTags(scene.tags).includes("staff") || /staff|crew|agent|officer|engineer|handler|medic|police|pilot|controller|inspector/.test(people);

  const categories = handsOnly
    ? ["Regional look", "Clothing style", "Clothing color", "Accessory"]
    : [
        staff ? "Group type (staff or other)" : "Group type (traveler)",
        "Regional look",
        "Age band",
        "Gender presentation",
        "Build",
        "Hair",
        "Facial hair",
        "Clothing style",
        "Clothing color",
        "Accessory",
        "Expression",
        ...(crowd ? ["Crowd density", "Group size"] : []),
        "Face visibility",
      ];

  const res = await db
    .prepare(
      `SELECT id, category, value, tags, weight FROM people_options WHERE category IN (${categories.map(() => "?").join(",")})`,
    )
    .bind(...categories)
    .all<OptionRow>();
  const rows = res.results ?? [];

  const contexts = sceneContexts(scene);
  const cast: Record<string, string> = {};
  const ids: number[] = [];
  for (const category of categories) {
    const options = rows.filter(
      (r) =>
        r.category === category &&
        optionAllowed(r, { severity: input.severity, mood: input.mood, contexts, weather, recent, id: r.id }),
    );
    // Facial hair only sometimes; hands-only and high severity never need faces.
    if (category === "Facial hair" && rnd() < 0.7) continue;
    let pool = options;
    if (category.startsWith("Group type")) {
      const text = `${scene.name} ${scene.people} ${scene.description}`.toLowerCase();
      const scored = options.map((o) => ({ o, sc: groupScore(o.value, text) }));
      const best = Math.max(0, ...scored.map((x) => x.sc));
      if (best === 0) continue; // nothing in the scene names this group: leave it to the scene text
      pool = scored.filter((x) => x.sc === best).map((x) => x.o);
    }
    const pick = weightedPick(pool, rnd);
    if (pick) {
      cast[category] = pick.value;
      ids.push(pick.id);
    }
  }
  return { cast, ids, note: handsOnly ? "hands only: do not show faces" : input.severity === "high" ? "faces turned away or distant" : "" };
}

async function pickModifiers(db: SceneDb, input: BuildInput, scene: SceneRow, weather: string, recent: Set<string>, rnd: () => number) {
  const res = await db.prepare("SELECT id, category, value, tags, weight FROM place_modifiers").bind().all<OptionRow>();
  const rows = res.results ?? [];
  const byCategory = new Map<string, OptionRow[]>();
  for (const r of rows) {
    // Seasonal decor needs the post date and region; not wired in v1, so the category is skipped.
    if (r.category === "Seasonal decor") continue;
    const tags = optionTags(r.tags);
    if (input.severity === "high" && !tags.includes("h")) continue;
    if (tags.includes("p") && (!POSITIVE_MOODS.has(input.mood.toLowerCase()) || input.severity === "high")) continue;
    if (tags.includes("rain") && !/rain|storm|wet/i.test(weather)) continue;
    if (tags.includes("acft") && !sceneTags(scene.tags).includes("acft")) continue;
    if (recent.has(String(r.id))) continue;
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }
  const categories = weightedShuffle([...byCategory.keys()].map((c) => ({ c, weight: 1 })), rnd).map((x) => x.c);
  const count = 2 + Math.floor(rnd() * 3); // 2-4
  const picked: OptionRow[] = [];
  for (const category of categories) {
    if (picked.length >= count) break;
    const pick = weightedPick(byCategory.get(category)!, rnd);
    if (pick) picked.push(pick);
  }
  return picked;
}

function regionMatches(rowRegion: string, region: string | undefined): boolean {
  const regions = parseList(rowRegion, /;/).map((r) => r.toLowerCase());
  if (!region) return true;
  return regions.includes("any") || regions.includes(region.toLowerCase());
}

export async function buildParts(db: SceneDb, input: BuildInput, rnd: () => number = Math.random) {
  const scene = await db.prepare("SELECT * FROM scenes WHERE id = ? AND active = 1").bind(input.scene_id).first<SceneRow>();
  if (!scene) return { error: "Scene not found.", status: 404 as const };
  if (!severityAllowed(scene.severity, input.severity)) {
    return { error: `Scene ${scene.id} does not allow severity ${input.severity}.`, status: 400 as const };
  }

  const recent = await recentPostValues(db);

  // --- setup ---
  const setupIds = sceneSetupIds(scene).filter((id) => !SETUP_BLOCK[input.severity].includes(id));
  const setups = setupIds.length
    ? ((
        await db
          .prepare(`SELECT * FROM setup_types WHERE id IN (${setupIds.map(() => "?").join(",")})`)
          .bind(...setupIds)
          .all<Record<string, string>>()
      ).results ?? [])
    : [];
  const mood = input.mood.trim();
  const moodOk = setups.filter((s) => {
    const allowed = parseList(s.allowed_moods, /;/).map((m) => m.toLowerCase());
    return !allowed.length || allowed[0] === "all" || allowed.includes(mood.toLowerCase());
  });
  if (!moodOk.length) {
    return {
      error: `No setup fits scene ${scene.id} with severity ${input.severity} and mood ${mood}. Pick another scene or mood.`,
      status: 409 as const,
    };
  }
  const notRecent = moodOk.filter((s) => !recent.setups.includes(Number(s.id)));
  const setup = pickOne(notRecent.length ? notRecent : moodOk, rnd)!;

  // --- camera ---
  const shots = [scene.shot_type, scene.shot_type_alt ?? ""].filter(Boolean);
  const pick = (value: string | null | undefined, generic: string[] = []) => pickOne(listFromSetup(value, generic), rnd) ?? "";
  const timeOfDay = input.time_of_day?.trim() || pick(setup.time_of_day, GENERIC_TIMES);
  const weather = input.weather?.trim() || pick(setup.weather, GENERIC_WEATHER);
  const camera = {
    device: setup.device,
    lens: pick(setup.lens),
    depth_of_field: pick(setup.depth_of_field),
    shutter_feel: pick(setup.shutter_feel),
    height_angle: pick(setup.height_angle),
    compass_angle: compass(setup.compass_angle, rnd),
    distance: pickOne(fitDistance(parseList(setup.distance, /;/), shots), rnd) ?? "",
    framing: pickOne(fitFraming(parseList(setup.framing, /;/), shots), rnd) ?? "",
    tilt: pick(setup.tilt),
    time_of_day: timeOfDay,
    weather,
    light_type: pick(setup.light_type),
    light_direction: pick(setup.light_direction),
    color_grade: pick(setup.color_grade),
    image_quality: pick(setup.image_quality),
    lens_flaws: pick(setup.lens_flaws),
  };

  // --- place ---
  const placeRows =
    (
      await db
        .prepare("SELECT * FROM places_options WHERE (grp || ' / ' || spot) = ?")
        .bind(scene.place_type)
        .all<Record<string, string | number>>()
    ).results ?? [];
  let place = placeRows[0] ?? null;
  let placeNote = "";
  if (input.place_name && place) {
    const real = (
      await db
        .prepare("SELECT * FROM places_options WHERE LOWER(real_name) = LOWER(?) AND tags LIKE '%real%'")
        .bind(input.place_name)
        .all<Record<string, string | number>>()
    ).results?.[0];
    if (real && scene.place_type.split(" / ")[0] === real.grp) {
      place = real;
      placeNote = "Real place named in the story: describe only by well-known traits.";
    }
  }
  if (place && input.region && !regionMatches(String(place.region ?? "Any"), input.region)) {
    placeNote = (placeNote + " Place region differs from the story region; keep it generic.").trim();
  }

  // --- modifiers and cast ---
  const modifiers = await pickModifiers(db, input, scene, weather, recent.modifiers, rnd);
  const castResult = await pickCast(db, scene, input, weather, recent.cast, rnd);

  // --- log ---
  let postId: number | null = null;
  if (!input.dry_run) {
    await db
      .prepare(
        `INSERT INTO posts (news_id, headline, topic_id, severity, mood, scene_id, setup_id, cast_ids, place_id, modifier_ids, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
      )
      .bind(
        input.news_id ?? null,
        input.headline ?? null,
        input.topic_id ?? null,
        input.severity,
        mood,
        scene.id,
        Number(setup.id),
        castResult.ids.join(","),
        place ? Number(place.id) : null,
        modifiers.map((m) => m.id).join(","),
      )
      .run();
    const row = await db.prepare("SELECT MAX(id) AS id FROM posts").bind().first<{ id: number }>();
    postId = row?.id ?? null;
  }

  const branding = input.severity === "high" ? "unbranded" : "brand only if references are supplied";

  return {
    status: 200 as const,
    post_id: postId,
    scene: {
      id: scene.id,
      name: scene.name,
      description: scene.description,
      shot_type: scene.shot_type,
      shot_type_alt: scene.shot_type_alt,
      people: scene.people,
      must_not_imply: scene.must_not_imply,
      refs: scene.refs,
    },
    setup: { id: Number(setup.id), name: setup.name },
    camera,
    place: place
      ? {
          id: Number(place.id),
          group: place.grp,
          spot: place.spot,
          real_name: place.real_name || null,
          description: place.description,
          note: placeNote || null,
        }
      : null,
    modifiers: modifiers.map((m) => ({ id: m.id, category: m.category, value: m.value })),
    cast: castResult.cast,
    cast_note: castResult.note || null,
    mood,
    severity: input.severity,
    branding,
    rules: {
      no_text_or_logos: true,
      invented_anonymous_people_only: true,
      faces_hidden: input.severity === "high",
    },
  };
}
