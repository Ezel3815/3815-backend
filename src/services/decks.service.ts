import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
    DeckType,
    MediaType,
    Prisma,
    User,
    UserRole,
    UserStatus,
} from "@prisma/client";
import { IncomingMessage } from "http";
import { PrismaService } from "nestjs-prisma";
import { JwtConstant } from "src/constants/jwt.constant";
import { LoginDto } from "src/dtos/auth/login.dto";
import { RegisterDto } from "src/dtos/auth/register.dto";
import { CreateDeckDto } from "src/dtos/decks/create-deck.dto";
import { cachedHierarchy, invalidateHierarchy } from "src/utils/hierarchy-cache";
import { DeckRecursiveOutDto } from "src/dtos/decks/deck-recursive.out-dto";
import { ShareDeckDto } from "src/dtos/decks/share-deck.dto";
import { UpdateDeckDto } from "src/dtos/decks/update-deck.dto";
import { FindQueryDto } from "src/dtos/find-query.dto";
import { CreateUserDto } from "src/dtos/users/create-user.dto";
import { UpdateMeDto } from "src/dtos/users/update-me.dto";
import { UpdatePasswordDto } from "src/dtos/users/update-password.dto";
import { UpdateUserDto } from "src/dtos/users/update-user.dto";
import { UserOutDto } from "src/dtos/users/user.out-dto";
import { GenerateBadRequestException } from "src/exception/bad-request.exception";
import { GenerateUnauthorizedException } from "src/exception/unauthorized.exception";
import { GenerateUnprocessableEntityException } from "src/exception/unprocessable-entity.exception";
import { generateRandomCode } from "src/utils/code-generation.utils";
import uuid from "uuid";
import { MediaService } from "./media.service";
import { DocumentOutDto } from "src/dtos/decks/document.out-dto";
import { UserDeckOutDto } from "src/dtos/decks/user-deck.out-dto";
import { DecksCardsService } from "./decks-cards.service";
import { log } from "console";
import { DeckOutDto } from "src/dtos/decks/deck_out_dto";
import { CopyFile } from "src/utils/files.utils";

@Injectable()
export class DecksService {
    constructor(
        private prismaService: PrismaService,
        private mediaService: MediaService,
        @Inject(forwardRef(() => DecksCardsService))
        private decksCardsService: DecksCardsService,
    ) {}

    async checkOwnership(
        user: User,
        deckId: number,
        extraUserDeckFilters?: Prisma.UserDeckWhereInput,
        extraDeckFilters?: Prisma.DeckWhereInput,
    ) {
        if (user?.role != UserRole.ADMIN) {
            // CRITICAL: this findFirst was never awaited, so `userDeck` was
            // always a pending Promise — never falsy — meaning this check
            // silently passed for EVERY user on EVERY deck, regardless of
            // actual ownership. This is the real root cause of "answered a
            // card in another user's private deck" (BUG #1) and affected
            // every caller of checkOwnership, not just card answers.
            const userDeck = await this.prismaService.userDeck.findFirst({
                where: {
                    user_id: user.id,
                    deck_id: deckId,
                    ...(extraUserDeckFilters ?? {}),
                    deck: extraDeckFilters ?? {},
                },
            });

            if (!userDeck) return false;
        }
        return true;
    }

    async create(user: User, createDeckDto: CreateDeckDto) {
        //TODO: check for circualr decks (one is child on one and the second is also child of the first)

        if (createDeckDto.parent_id) {
            const parent = await this.prismaService.deck.findFirst({
                where: { id: createDeckDto.parent_id },
            });

            if (!parent || parent.type != DeckType.PACKAGE_DECK) {
                GenerateBadRequestException([
                    "You can't add sub-deck to this deck",
                ]);
            }
        }

        const deck = await this.prismaService.deck.create({
            data: {
                title: createDeckDto.title,
                type: createDeckDto.type,
                by_admin: user.role == UserRole.ADMIN,
                parent_id: createDeckDto.parent_id,
                public: createDeckDto.public,
                visible: createDeckDto.visible,
                order: createDeckDto.order ?? undefined
            },
        });

        const userDeck = await this.prismaService.userDeck.create({
            data: {
                deck_id: deck.id,
                user_id: user.id,
                sharable: true,
                editable: true,
            },
            include: {
                deck: { include: { cards: { include: { answers: true } } } },
            },
        });

        invalidateHierarchy(); // new deck must show up right away for everyone
        return UserDeckOutDto(userDeck);
    }

    async read(findQueryDto: FindQueryDto) {
        if (findQueryDto?.filter?.by_admin) {
            findQueryDto.filter.by_admin =
                findQueryDto.filter.by_admin == "true";
        }
        const decks = await this.prismaService.deck.findMany({
            skip: findQueryDto.skip,
            take: findQueryDto.limit,
            where: findQueryDto.filter ?? {},
            orderBy: findQueryDto.sort ?? { created_at: "desc" },
            include: { parent: true },
        });

        const count = await this.prismaService.deck.count({
            where: findQueryDto.filter ?? {},
        });

        return { count, data: decks };
    }

    generateRecursiveIncludeQuery(
        user: User,
        level: number = 8,
    ): Prisma.DeckInclude {
        if (level == 0)
            return {
                cards: {
                    include: { answers: { where: { user_id: user.id } } },
                },
                users: {
                     where: { user_id: user.id,},
                  select: { user_id: true } }, // Required to check sharing

            };

        return {
            cards: { include: { answers: { where: { user_id: user.id } } } },
            
            users: {  where: { user_id: user.id,},
                        select: { user_id: true } }, 

            children:
                user.role == UserRole.ADMIN
                    ? {
                          include: this.generateRecursiveIncludeQuery(
                              user,
                              level - 1,
                          ),
                          orderBy: {
                              order: "asc",
                          },
                      }
                    : {
                        
                          include: this.generateRecursiveIncludeQuery(
                              user,
                              level - 1,
                          ),
                          orderBy: {
                              order: "asc",
                          },
                          
                      },
        };
    }

    async readHierarchy(user: User) {
        return cachedHierarchy(user.id, async () => {
            const decks: any = await this.prismaService.deck.findMany({
                where: {
                    by_admin: true,
                    parent_id: null,
                    ...(user.role == UserRole.ADMIN ? {} : { visible: true }),
                },
                include: this.generateRecursiveIncludeQuery(user, 9),
                orderBy: { order: "asc" },
            });
            return decks.map((deck) => DeckRecursiveOutDto(user, deck));
        });
    }


async readHierarchy1(user: User, parentId: number | null) {
    const decks = await this.prismaService.deck.findMany({
        where: {
            by_admin: true,
            parent_id: parentId,
            ...(user.role == UserRole.ADMIN ? {} : { visible: true }),
        },
        include: {
            cards: {
                include: {
                    answers: { where: { user_id: user.id } },
                },
            },
            users: {
                where: { user_id: user.id },
                select: { user_id: true },
            },
            _count: {
                select: {
                    children: true,
                },
            },
        },
        orderBy: {
            order: "asc",
        },
    });

    return decks.map((deck) => DeckOutDto(user, deck));
}

    async readMine(user: User) {
        const userDeck = await this.prismaService.userDeck.findMany({
            where: { user_id: user.id, deck: { by_admin: false } },
            include: {
                deck: {
                    include: {
                        cards: {
                            include: {
                                answers: { where: { user_id: user.id } },
                            },
                        },
                    },
                },
            },
        });

        return userDeck.map((ud) => UserDeckOutDto(ud));
    }

    async readOne(id: number) {
        const deck = await this.prismaService.deck.findUnique({
            where: { id },
        });

        return deck;
    }

    async update(user: User, id: number, updateDeckDto: UpdateDeckDto) {
        if (!(await this.checkOwnership(user, id, { editable: true })))
            GenerateBadRequestException([
                "You can't edit a deck that you don't own",
            ]);

        // Moving a deck under a parent: apply the same rule create() already
        // has. Only a "Decks Package" can hold sub-decks. Before this check the
        // move was saved silently, but the app treats a Cards Deck as a plain
        // list of cards (and an EMPTY Cards Deck counts as locked, which hides
        // everything inside it).
        if (updateDeckDto.parent_id) {
            const existing = await this.prismaService.deck.findUnique({
                where: { id },
                select: { parent_id: true },
            });
            // only check when the parent is actually changing, so editing the
            // title of an older deck is never blocked
            if (existing && existing.parent_id !== updateDeckDto.parent_id) {
                if (updateDeckDto.parent_id === id)
                    GenerateBadRequestException([
                        "A deck can't be its own parent",
                    ]);

                const parent = await this.prismaService.deck.findUnique({
                    where: { id: updateDeckDto.parent_id },
                });
                if (!parent || parent.type != DeckType.PACKAGE_DECK)
                    GenerateBadRequestException([
                        "You can't add a sub-deck to this deck. Set its type to Decks Package first (a Cards Deck can only hold cards).",
                    ]);

                // walk up from the new parent: it must not sit inside this deck
                let cursor: number | null = parent.parent_id;
                for (let hops = 0; cursor != null && hops < 50; hops++) {
                    if (cursor === id)
                        GenerateBadRequestException([
                            "A deck can't be moved inside one of its own sub-decks",
                        ]);
                    const up = await this.prismaService.deck.findUnique({
                        where: { id: cursor },
                        select: { parent_id: true },
                    });
                    cursor = up?.parent_id ?? null;
                }
            }
        }

        if (updateDeckDto.type) {
            const current = await this.prismaService.deck.findUnique({
                where: { id },
                include: { _count: { select: { children: true, cards: true } } },
            });
            if (current && current.type !== updateDeckDto.type) {
                if (
                    updateDeckDto.type === DeckType.PACKAGE_DECK &&
                    current._count.cards > 0
                )
                    GenerateBadRequestException([
                        "Move this deck's cards out before turning it into a Decks Package",
                    ]);
                if (
                    updateDeckDto.type === DeckType.CARDS_DECK &&
                    current._count.children > 0
                )
                    GenerateBadRequestException([
                        "Move the sub-decks out before turning this package into a Cards Deck",
                    ]);
            }
        }

        const deck = await this.prismaService.deck.update({
            where: {
                id,
            },
            data: {
                title: updateDeckDto.title,
                parent_id: updateDeckDto.parent_id,
                public: updateDeckDto.public,
                visible: updateDeckDto.visible,
                type: updateDeckDto.type,
                order: updateDeckDto.order ?? undefined
            },
        });

        invalidateHierarchy();
        return deck;
    }

    async deleteIfOrphan(deckId: number) {
        const deck = await this.prismaService.deck.findUnique({
            where: {
                id: deckId,
            },
            include: {
                cards: true,
            },
        });

        if (deck.by_admin) return;

        const count = await this.prismaService.userDeck.count({
            where: {
                deck_id: deckId,
            },
        });

        if (count == 0) {
            await this.delete(deckId);
        }
    }

    // Copies a deck with everything inside it (sub-decks, cards, images/PDFs)
    // into another Decks Package. NOT copied: students' answers/progress, codes
    // and share links. If anything fails, the partial copy is removed again.
    async copy(user: User, id: number, targetParentId: number | null) {
        const source = await this.prismaService.deck.findUnique({ where: { id } });
        if (!source) GenerateBadRequestException(["Deck not found"]);

        if (targetParentId) {
            const target = await this.prismaService.deck.findUnique({
                where: { id: targetParentId },
            });
            if (!target) GenerateBadRequestException(["Target deck not found"]);
            if (target.type !== DeckType.PACKAGE_DECK)
                GenerateBadRequestException([
                    "The target must be a Decks Package",
                ]);
            // never into itself or one of its own sub-decks
            let cursor: number | null = targetParentId;
            for (let i = 0; cursor && i < 50; i++) {
                if (cursor === id)
                    GenerateBadRequestException([
                        "A deck can't be copied into itself or into its own sub-decks",
                    ]);
                const up = await this.prismaService.deck.findUnique({
                    where: { id: cursor },
                    select: { parent_id: true },
                });
                cursor = up?.parent_id ?? null;
            }
        }

        const created: number[] = [];
        try {
            // copying next to the original: mark it so the two can be told apart
            const suffix = source.parent_id === targetParentId ? " (copy)" : "";
            const root = await this.copyTree(user, id, targetParentId, suffix, created, 0);
            invalidateHierarchy();
            return { id: root.id, title: root.title, decks: created.length };
        } catch (e) {
            for (const deckId of [...created].reverse()) {
                try {
                    await this.delete(deckId);
                } catch {}
            }
            invalidateHierarchy();
            throw e;
        }
    }

    private async copyTree(
        user: User,
        sourceId: number,
        parentId: number | null,
        titleSuffix: string,
        created: number[],
        depth: number,
    ) {
        if (depth > 20) throw new Error("Deck tree is too deep to copy");
        const src = await this.prismaService.deck.findUnique({
            where: { id: sourceId },
            include: {
                cards: { orderBy: { order: "asc" } },
                children: { orderBy: { order: "asc" } },
            },
        });

        const deck = await this.prismaService.deck.create({
            data: {
                title: src.title + titleSuffix,
                type: src.type,
                by_admin: user.role == UserRole.ADMIN,
                parent_id: parentId,
                public: src.public,
                visible: src.visible,
                order: src.order,
            },
        });
        created.push(deck.id);
        await this.prismaService.userDeck.create({
            data: {
                deck_id: deck.id,
                user_id: user.id,
                sharable: true,
                editable: true,
            },
        });

        for (const card of src.cards) await this.copyCard(card, deck.id);
        for (const child of src.children)
            await this.copyTree(user, child.id, deck.id, "", created, depth + 1);
        return deck;
    }

    private async copyCard(card: any, deckId: number) {
        // old media name -> new media name (each card needs its own files)
        const renamed = new Map<string, string | null>();
        const names = [
            ...new Set(
                [card.front_image_name, card.back_image_name, card.document_name].filter(
                    Boolean,
                ),
            ),
        ] as string[];
        await Promise.all(
            names.map(async (name) => {
                const media = await this.prismaService.media.findUnique({ where: { name } });
                if (!media) {
                    renamed.set(name, null); // orphaned reference: nothing to copy
                    return;
                }
                const newName = await CopyFile(name);
                await this.prismaService.media.create({
                    data: { name: newName, type: media.type },
                });
                renamed.set(name, newName);
            }),
        );

        // card.data may mention the old file names: point them at the copies
        let json = JSON.stringify(card.data ?? null);
        for (const [oldName, newName] of renamed)
            if (newName) json = json.split(oldName).join(newName);

        const pick = (n: string | null) => (n ? (renamed.get(n) ?? null) : null);
        await this.prismaService.card.create({
            data: {
                deck_id: deckId,
                order: card.order,
                type: card.type,
                data: JSON.parse(json),
                document_title: card.document_title,
                document_name: pick(card.document_name),
                front_image_name: pick(card.front_image_name),
                back_image_name: pick(card.back_image_name),
            },
        });
    }

    async delete(id: number) {
        const cards = await this.prismaService.card.findMany({
            where: { deck_id: id },
        });

        for (let card of cards) {
            await this.decksCardsService.delete(undefined, id, card.id);
        }

        await this.prismaService.$transaction([
            this.prismaService.userDeck.deleteMany({
                where: {
                    deck_id: id,
                },
            }),

            this.prismaService.card.deleteMany({
                where: {
                    deck_id: id,
                },
            }),

            this.prismaService.codeDeck.deleteMany({
                where: {
                    deck_id: id,
                },
            }),

            this.prismaService.deck.delete({
                where: { id },
            }),
        ]);
        invalidateHierarchy();
    }

    async unlink(user: User, id: number) {
        // Same class of bug as inside checkOwnership itself: calling an
        // async function without awaiting it means you're negating a
        // Promise, which is never falsy, so this check never fired.
        if (!(await this.checkOwnership(user, id, { editable: true })))
            GenerateBadRequestException([
                "You can't delete a deck that you don't own",
            ]);

        const deck = await this.prismaService.userDeck.delete({
            where: { user_id_deck_id: { user_id: user.id, deck_id: id } },
        });

        await this.deleteIfOrphan(id);

        if (!deck) GenerateBadRequestException(["User does not exist"]);

        return true;
    }

    async getShareCode(user: User, id: number, shareDeckDto: ShareDeckDto) {
        // Same missing-await bug as unlink() above.
        if (!(await this.checkOwnership(user, id, { sharable: true })))
            GenerateBadRequestException(["You can't share this deck"]);

        const code = generateRandomCode(6);

        const userDeck = await this.prismaService.userDeck.update({
            where: {
                user_id_deck_id: {
                    user_id: user.id,
                    deck_id: id,
                },
            },
            data: {
                share_is_editable: shareDeckDto.editable,
                share_is_sharable: shareDeckDto.sharable,
                share_code: code,
            },
        });

        return { code };
    }

    async linkByShareCode(user: User, code: string) {
        const userDeck = await this.prismaService.userDeck.findFirst({
            where: {
                share_code: code,
            },
        });

        if (!userDeck) GenerateBadRequestException(["Wrong code"]);

        const currentUserDeck = await this.prismaService.userDeck.findFirst({
            where: {
                user_id: user.id,
                deck_id: userDeck.deck_id,
            },
        });

        if (currentUserDeck) {
            await this.prismaService.userDeck.update({
                where: {
                    user_id_deck_id: {
                        user_id: user.id,
                        deck_id: userDeck.deck_id,
                    },
                },
                data: {
                    editable:
                        currentUserDeck.editable || userDeck.share_is_editable,
                    sharable:
                        currentUserDeck.sharable || userDeck.share_is_sharable,
                },
            });
        } else {
            await this.prismaService.userDeck.create({
                data: {
                    user_id: user.id,
                    deck_id: userDeck.deck_id,
                    editable: userDeck.share_is_editable,
                    sharable: userDeck.share_is_sharable,
                },
            });
        }
    }
}
