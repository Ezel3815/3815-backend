import {
    Card,
    CardAnswer,
    Deck,
    DeckType,
    User,
    UserRole,
} from "@prisma/client";

export type DeckReqursive = Deck & {
    cards: (Card & { answers: CardAnswer[] })[];
    children?: DeckReqursive[];
    users?: { user_id: number }[];
};

function countAnswers(cards: (Card & { answers: CardAnswer[] })[]) {
    let easyGood = 0;
    let again = 0;
    let hard = 0;

    for (const card of cards) {
        const answer = card.answers?.[0]?.answer;
        if (answer === "EASY" || answer === "GOOD") easyGood++;
        else if (answer === "AGAIN") again++;
        else if (answer === "HARD") hard++;
    }

    return { easyGoodCount: easyGood, againCount: again, hardCount: hard };
}

/**
 * Recursively counts every leaf card under this deck (including its own
 * direct cards) and how many of those cards the user has answered at
 * least once. This is the source of truth for whether a deck (subject /
 * chapter / lesson, since they're all just "Deck" in the schema) counts
 * as "completed" for unlocking purposes.
 */
function countProgressRecursive(deck: DeckReqursive): {
    total: number;
    attempted: number;
} {
    let total = deck.cards?.length ?? 0;
    let attempted =
        deck.cards?.filter((c) => (c.answers?.length ?? 0) > 0).length ?? 0;

    for (const child of deck.children ?? []) {
        const childProgress = countProgressRecursive(child);
        total += childProgress.total;
        attempted += childProgress.attempted;
    }

    return { total, attempted };
}

function isDeckCompleted(deck: DeckReqursive): boolean {
    const { total, attempted } = countProgressRecursive(deck);
    // A deck with no cards anywhere under it can never be "completed" -
    // it shouldn't be able to silently unlock the next chapter.
    return total > 0 && attempted === total;
}

/**
 * @param depth 0 = top-level subject, 1 = "chapter" (the level shown as
 *              the lesson road on the home screen - sequential unlock
 *              applies here), 2+ = everything nested inside a chapter,
 *              which opens all at once as soon as the chapter is unlocked.
 * @param siblings the deck's siblings at the same level (needed to check
 *              "was the previous one finished" for sequential unlock).
 * @param index the deck's position among `siblings`.
 * @param parentUnlocked whether the parent deck itself is unlocked -
 *              a locked parent always locks everything beneath it.
 */
export function DeckRecursiveOutDto(
    user: User,
    deck: DeckReqursive,
    depth: number = 0,
    siblings: DeckReqursive[] = [],
    index: number = 0,
    parentUnlocked: boolean = true,
) {
    const { cards, ...deckWithoutCards } = deck;

    // Hidden decks (visible = false) are not shown to regular users at all.
    const visibleChildren = (deck.children ?? []).filter(
        (c: any) => user.role == UserRole.ADMIN || c.visible !== false,
    );

    const shared = deck.users.some((u) => u.user_id === user.id);

    // Pre-existing gating: not public/shared, or an empty package/deck.
    const baseLocked =
        user.role != UserRole.ADMIN &&
        ((deck.public && shared === false) ||
            (deck.type == DeckType.PACKAGE_DECK &&
                visibleChildren.length == 0) ||
            (deck.type == DeckType.CARDS_DECK && deck.cards.length == 0));

    // A "chapter" is a card deck among sibling card decks (the lesson road),
    // wherever it sits in the tree. Sequential unlock applies only there —
    // NOT to subjects/years, or every subject after the first would be
    // hidden until the previous one was fully finished.
    const isChapter =
        deck.type == DeckType.CARDS_DECK &&
        siblings.length > 0 &&
        siblings.every((s) => s.type == DeckType.CARDS_DECK);

    // A chapter unlocks once the previous chapter is fully completed.
    let sequentialLocked = false;
    if (user.role != UserRole.ADMIN && isChapter && index > 0) {
        const previousSibling = siblings[index - 1];
        sequentialLocked = !isDeckCompleted(previousSibling);
    }

    const isLocked = baseLocked || !parentUnlocked || sequentialLocked;

    const completed = isDeckCompleted(deck);
    const { total, attempted } = countProgressRecursive(deck);
    const progressPercent =
        total > 0 ? Math.round((attempted / total) * 100) : 0;

    // The single chapter the home-screen road should highlight as
    // "in progress" - the first unlocked-but-not-finished chapter.
    const current = isChapter && !isLocked && !completed;

    const answerCounts = countAnswers(deck.cards);

    return {
        ...deckWithoutCards,
        // Slim card list (id + the user's answer) so clients can compute
        // progress; full card data is fetched per deck via /cards/:deckId.
        cards: cards.map((c) => ({
            id: c.id,
            deck_id: c.deck_id,
            order: c.order,
            type: c.type,
            answer: c.answers?.[0]?.answer ?? "NONE",
        })),
        editable: user.role == UserRole.ADMIN,
        sharable: false,
        easyGoodCount: answerCounts.easyGoodCount,
        againCount: answerCounts.againCount,
        hardCount: answerCounts.hardCount,
        totalCards: total,
        attemptedCards: attempted,
        progressPercent,
        completed,
        current,
        children:
            isLocked === true
                ? []
                : visibleChildren.map((child, childIndex) =>
                      DeckRecursiveOutDto(
                          user,
                          child,
                          depth + 1,
                          visibleChildren,
                          childIndex,
                          !isLocked,
                      ),
                  ),
        shared,
        locked: isLocked,
    };
}
