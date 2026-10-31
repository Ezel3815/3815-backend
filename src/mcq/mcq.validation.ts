/**
 * Pure validation + normalisation for MCQ content (no Nest / Prisma imports,
 * so it is trivially unit-testable). The rules deliberately mirror the Flutter
 * app's parser (McqQuestion.tryParse) so anything the dashboard accepts, the
 * app accepts.
 */

export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OPTION_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export const LIMITS = {
    name: 191,
    title: 255,
    questionText: 20000,
    optionText: 2000,
    explanation: 20000,
    keyPoints: 20,
    keyPoint: 500,
    examLabel: 64,
    source: 255,
    minOptions: 2,
    maxOptions: 12, // letters A..L
    maxOrder: 1_000_000,
} as const;

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface SubjectValue {
    id?: string;
    name?: string;
    name_en?: string | null;
    order?: number;
    published?: boolean;
}
export interface CollectionValue {
    id?: string;
    subject_id?: string;
    title?: string;
    title_en?: string | null;
    order?: number;
    published?: boolean;
}
export interface OptionValue {
    id: string;
    text: string;
}
export interface QuestionValue {
    id?: string;
    subject_id?: string; // optional: derived from the collection; if given it must match
    collection_id?: string;
    text?: string;
    options?: OptionValue[];
    correct?: string[];
    explanation?: string | null;
    key_points?: string[] | null;
    exam_label?: string | null;
    source?: string | null;
    order?: number;
    published?: boolean;
}

interface Opts {
    /** partial = update: only validate fields that are present. */
    partial?: boolean;
    /** id is mandatory (import files). On create via API it may be omitted (server generates). */
    requireId?: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(
    v: unknown,
    field: string,
    max: number,
    errors: string[],
    required: boolean,
    nonEmpty = true,
): string | undefined {
    if (v === undefined) {
        if (required) errors.push(`${field} is required`);
        return undefined;
    }
    if (typeof v !== "string") {
        errors.push(`${field} must be a string`);
        return undefined;
    }
    const t = v.trim();
    // A supplied required field (even in a partial update) can never be blank.
    if (nonEmpty && t.length === 0) {
        errors.push(`${field} must not be empty`);
        return undefined;
    }
    if (t.length > max) {
        errors.push(`${field} is too long (max ${max} characters)`);
        return undefined;
    }
    return t;
}

/** Optional text: undefined => untouched, null / "" => cleared (null). */
function optStr(
    v: unknown,
    field: string,
    max: number,
    errors: string[],
): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const t = str(v, field, max, errors, false, false);
    if (t === undefined) return undefined;
    return t.length === 0 ? null : t;
}

function intField(
    v: unknown,
    field: string,
    errors: string[],
): number | undefined {
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > LIMITS.maxOrder) {
        errors.push(`${field} must be an integer between 0 and ${LIMITS.maxOrder}`);
        return undefined;
    }
    return v as number;
}

function boolField(
    v: unknown,
    field: string,
    errors: string[],
): boolean | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") {
        errors.push(`${field} must be true or false`);
        return undefined;
    }
    return v;
}

function idField(
    v: unknown,
    field: string,
    errors: string[],
    required: boolean,
): string | undefined {
    if (v === undefined || v === null || v === "") {
        if (required) errors.push(`${field} is required`);
        return undefined;
    }
    if (typeof v !== "string" || !ID_RE.test(v)) {
        errors.push(
            `${field} must be 1-64 chars: lowercase letters, digits, '.', '_' or '-' (starting with a letter or digit)`,
        );
        return undefined;
    }
    return v;
}

function strip<T extends object>(o: T): T {
    for (const k of Object.keys(o)) {
        if ((o as any)[k] === undefined) delete (o as any)[k];
    }
    return o;
}

export function validateSubject(input: unknown, opts: Opts = {}): Result<SubjectValue> {
    if (!isObj(input)) return { ok: false, errors: ["subject must be an object"] };
    const errors: string[] = [];
    const v: SubjectValue = {
        id: idField(input.id, "id", errors, !!opts.requireId),
        name: str(input.name, "name", LIMITS.name, errors, !opts.partial),
        name_en: optStr(input.name_en, "name_en", LIMITS.name, errors),
        order: intField(input.order, "order", errors),
        published: boolField(input.published, "published", errors),
    };
    return errors.length ? { ok: false, errors } : { ok: true, value: strip(v) };
}

export function validateCollection(input: unknown, opts: Opts = {}): Result<CollectionValue> {
    if (!isObj(input)) return { ok: false, errors: ["collection must be an object"] };
    const errors: string[] = [];
    const v: CollectionValue = {
        id: idField(input.id, "id", errors, !!opts.requireId),
        subject_id: idField(input.subject_id, "subject_id", errors, !opts.partial),
        title: str(input.title, "title", LIMITS.title, errors, !opts.partial),
        title_en: optStr(input.title_en, "title_en", LIMITS.title, errors),
        order: intField(input.order, "order", errors),
        published: boolField(input.published, "published", errors),
    };
    return errors.length ? { ok: false, errors } : { ok: true, value: strip(v) };
}

export function validateQuestion(input: unknown, opts: Opts = {}): Result<QuestionValue> {
    if (!isObj(input)) return { ok: false, errors: ["question must be an object"] };
    const errors: string[] = [];

    const v: QuestionValue = {
        id: idField(input.id, "id", errors, !!opts.requireId),
        subject_id: idField(input.subject_id, "subject_id", errors, false),
        collection_id: idField(input.collection_id, "collection_id", errors, !opts.partial),
        text: str(input.text, "text", LIMITS.questionText, errors, !opts.partial),
        explanation: optStr(input.explanation, "explanation", LIMITS.explanation, errors),
        exam_label: optStr(input.exam_label, "exam_label", LIMITS.examLabel, errors),
        source: optStr(input.source, "source", LIMITS.source, errors),
        order: intField(input.order, "order", errors),
        published: boolField(input.published, "published", errors),
    };

    // options
    let options: OptionValue[] | undefined;
    if (input.options === undefined) {
        if (!opts.partial) errors.push("options is required");
    } else if (!Array.isArray(input.options)) {
        errors.push("options must be an array");
    } else if (input.options.length < LIMITS.minOptions) {
        errors.push(`needs at least ${LIMITS.minOptions} options`);
    } else if (input.options.length > LIMITS.maxOptions) {
        errors.push(`at most ${LIMITS.maxOptions} options are supported`);
    } else {
        const seen = new Set<string>();
        const list: OptionValue[] = [];
        let bad = false;
        input.options.forEach((o, i) => {
            if (!isObj(o)) {
                errors.push(`option ${i + 1} must be an object`);
                bad = true;
                return;
            }
            const oid = typeof o.id === "string" ? o.id.trim() : "";
            const text = typeof o.text === "string" ? o.text.trim() : "";
            if (!OPTION_ID_RE.test(oid)) {
                errors.push(`option ${i + 1}: id must be 1-32 chars (letters, digits, '_' or '-')`);
                bad = true;
            } else if (seen.has(oid)) {
                errors.push(`option ${i + 1}: duplicate option id "${oid}"`);
                bad = true;
            } else {
                seen.add(oid);
            }
            if (!text) {
                errors.push(`option ${i + 1}: text must not be empty`);
                bad = true;
            } else if (text.length > LIMITS.optionText) {
                errors.push(`option ${i + 1}: text is too long (max ${LIMITS.optionText})`);
                bad = true;
            }
            list.push({ id: oid, text });
        });
        if (!bad) options = list;
    }
    v.options = options;

    // correct (array of option ids, or a single id string)
    let correct: string[] | undefined;
    if (input.correct === undefined) {
        if (!opts.partial) errors.push("correct is required");
    } else {
        const raw = Array.isArray(input.correct) ? input.correct : [input.correct];
        const ids = raw.map((x) => (typeof x === "string" ? x.trim() : ""));
        if (ids.length === 0 || ids.some((x) => !x)) {
            errors.push("correct must list at least one option id");
        } else if (new Set(ids).size !== ids.length) {
            errors.push("correct contains the same option id twice");
        } else {
            correct = ids;
        }
    }
    v.correct = correct;

    // cross-check: every correct id must exist among the options
    if (options && correct) {
        const known = new Set(options.map((o) => o.id));
        const unknown = correct.filter((c) => !known.has(c));
        if (unknown.length) {
            errors.push(`correct refers to unknown option id(s): ${unknown.join(", ")}`);
        }
    } else if (opts.partial && (options === undefined) !== (correct === undefined)) {
        // Changing only one of them could silently break the answer key.
        if (input.options !== undefined || input.correct !== undefined) {
            errors.push("options and correct must be updated together");
        }
    }

    // key points
    if (input.key_points !== undefined) {
        if (input.key_points === null) {
            v.key_points = null;
        } else if (!Array.isArray(input.key_points)) {
            errors.push("key_points must be an array of strings");
        } else if (input.key_points.length > LIMITS.keyPoints) {
            errors.push(`at most ${LIMITS.keyPoints} key_points`);
        } else {
            const kp: string[] = [];
            for (const k of input.key_points) {
                if (typeof k !== "string") {
                    errors.push("key_points must be an array of strings");
                    break;
                }
                const t = k.trim();
                if (t.length > LIMITS.keyPoint) {
                    errors.push(`a key point is too long (max ${LIMITS.keyPoint})`);
                    break;
                }
                if (t) kp.push(t);
            }
            v.key_points = kp;
        }
    }

    return errors.length ? { ok: false, errors } : { ok: true, value: strip(v) };
}
