import {
    validateCollection,
    validateQuestion,
    validateSubject,
} from "./mcq.validation";

const goodQuestion = () => ({
    id: "q-1",
    collection_id: "c-1",
    text: "في كيسات الكبد البسيطة كل مما يلي صح ما عدا:",
    options: [
        { id: "a", text: "من أشيع آفات الكبد السليمة." },
        { id: "b", text: "لها جدار رقيق عديم التنبتات." },
        { id: "d", text: "معدل النكس بعد البزل منخفض للغاية." },
    ],
    correct: ["d"],
    explanation: "معدل النكس بعد البزل البسيط مرتفع.",
});

describe("validateQuestion", () => {
    it("accepts a complete Arabic question and trims text", () => {
        const r = validateQuestion({ ...goodQuestion(), text: "  سؤال؟  " }, { requireId: true });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.text).toBe("سؤال؟");
            expect(r.value.correct).toEqual(["d"]);
        }
    });

    it("accepts a single correct id given as a string", () => {
        const r = validateQuestion({ ...goodQuestion(), correct: "d" });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.correct).toEqual(["d"]);
    });

    it("supports multiple-answer questions", () => {
        const r = validateQuestion({ ...goodQuestion(), correct: ["a", "d"] });
        expect(r.ok).toBe(true);
    });

    it("rejects a correct id that is not an option", () => {
        const r = validateQuestion({ ...goodQuestion(), correct: ["z"] });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toContain("unknown option");
    });

    it("rejects missing/empty answer key", () => {
        expect(validateQuestion({ ...goodQuestion(), correct: undefined }).ok).toBe(false);
        expect(validateQuestion({ ...goodQuestion(), correct: [] }).ok).toBe(false);
        expect(validateQuestion({ ...goodQuestion(), correct: ["d", "d"] }).ok).toBe(false);
    });

    it("rejects fewer than 2 or more than 12 options and duplicate option ids", () => {
        expect(
            validateQuestion({ ...goodQuestion(), options: [{ id: "a", text: "x" }], correct: ["a"] }).ok,
        ).toBe(false);
        const many = Array.from({ length: 13 }, (_, i) => ({ id: `o${i}`, text: `t${i}` }));
        expect(validateQuestion({ ...goodQuestion(), options: many, correct: ["o1"] }).ok).toBe(false);
        expect(
            validateQuestion({
                ...goodQuestion(),
                options: [
                    { id: "a", text: "x" },
                    { id: "a", text: "y" },
                ],
                correct: ["a"],
            }).ok,
        ).toBe(false);
    });

    it("rejects empty text, empty option text and bad ids", () => {
        expect(validateQuestion({ ...goodQuestion(), text: "   " }).ok).toBe(false);
        expect(
            validateQuestion({
                ...goodQuestion(),
                options: [
                    { id: "a", text: "" },
                    { id: "b", text: "y" },
                ],
                correct: ["b"],
            }).ok,
        ).toBe(false);
        expect(validateQuestion({ ...goodQuestion(), id: "Has Spaces" }).ok).toBe(false);
        expect(validateQuestion({ ...goodQuestion(), id: "UPPER" }).ok).toBe(false);
    });

    it("explanation is optional; blank clears it (null)", () => {
        const none = validateQuestion({ ...goodQuestion(), explanation: undefined });
        expect(none.ok && none.value.explanation === undefined).toBe(true);
        const blank = validateQuestion({ ...goodQuestion(), explanation: "  " });
        expect(blank.ok && blank.value.explanation === null).toBe(true);
    });

    it("requireId is enforced for import records only", () => {
        const { id, ...noId } = goodQuestion();
        expect(validateQuestion(noId, { requireId: true }).ok).toBe(false);
        expect(validateQuestion(noId).ok).toBe(true);
    });

    it("partial update validates only supplied fields", () => {
        expect(validateQuestion({ text: "new text" }, { partial: true }).ok).toBe(true);
        expect(validateQuestion({ text: "" }, { partial: true }).ok).toBe(false);
    });

    it("partial update refuses to change options without correct (and vice versa)", () => {
        const optsOnly = validateQuestion(
            { options: goodQuestion().options },
            { partial: true },
        );
        expect(optsOnly.ok).toBe(false);
        const correctOnly = validateQuestion({ correct: ["a"] }, { partial: true });
        expect(correctOnly.ok).toBe(false);
        const both = validateQuestion(
            { options: goodQuestion().options, correct: ["a"] },
            { partial: true },
        );
        expect(both.ok).toBe(true);
    });

    it("validates key_points, order and published types", () => {
        expect(validateQuestion({ ...goodQuestion(), key_points: ["a", " b "] }).ok).toBe(true);
        expect(validateQuestion({ ...goodQuestion(), key_points: "nope" }).ok).toBe(false);
        expect(validateQuestion({ ...goodQuestion(), order: -1 }).ok).toBe(false);
        expect(validateQuestion({ ...goodQuestion(), published: "yes" }).ok).toBe(false);
    });

    it("rejects non-objects", () => {
        expect(validateQuestion(null).ok).toBe(false);
        expect(validateQuestion("x").ok).toBe(false);
        expect(validateQuestion([]).ok).toBe(false);
    });
});

describe("validateSubject / validateCollection", () => {
    it("subject needs a name; id optional unless requireId", () => {
        expect(validateSubject({ name: "الجراحة العامة" }).ok).toBe(true);
        expect(validateSubject({ name: "" }).ok).toBe(false);
        expect(validateSubject({ name: "x" }, { requireId: true }).ok).toBe(false);
        expect(validateSubject({ id: "general-surgery", name: "x" }, { requireId: true }).ok).toBe(true);
    });

    it("collection needs subject_id and title", () => {
        expect(validateCollection({ subject_id: "s", title: "t" }).ok).toBe(true);
        expect(validateCollection({ title: "t" }).ok).toBe(false);
        expect(validateCollection({ subject_id: "s" }).ok).toBe(false);
        expect(validateCollection({ title: "t2" }, { partial: true }).ok).toBe(true);
    });
});
