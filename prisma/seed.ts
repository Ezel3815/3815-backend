import {
    CardType,
    DeckType,
    PrismaClient,
    User,
    UserRole,
    UserStatus,
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import { md5 as uuid } from "../src/utils/md5";

const prisma = new PrismaClient();

// Users Entities
const users: Prisma.UserCreateManyInput[] = [
    {
        id: 1,
        name: "Admin1",
        email: "admin1@flash-card.com",
        password: uuid("12345678"),
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
    },
    {
        id: 2,
        name: "Admin2",
        email: "admin2@flash-card.com",
        password: uuid("12345678"),
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
    },
    {
        id: 3,
        name: "User1",
        email: "user1@flash-card.com",
        password: uuid("12345678"),
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
    },
    {
        id: 4,
        name: "User2",
        email: "user2@flash-card.com",
        password: uuid("12345678"),
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
    },
];

// Deck Entities
const decks: Prisma.DeckCreateManyInput[] = [
    {
        id: 1,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "First Year",
        parent_id: null,
    },
    {
        id: 2,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Second Year",
        parent_id: null,
    },
    {
        id: 3,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Third Year",
        parent_id: null,
    },
    {
        id: 4,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Fourth Year",
        parent_id: null,
    },
    {
        id: 5,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Fifth Year",
        parent_id: null,
    },
    {
        id: 6,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Sixth Year",
    },
    {
        id: 7,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "First Semester",
        parent_id: 1,
    },
    {
        id: 8,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Second Semester",
        parent_id: 1,
    },
    {
        id: 9,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "First Semester",
        parent_id: 2,
    },
    {
        id: 10,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Second Semester",
        parent_id: 2,
    },
    {
        id: 11,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "First Semester",
        parent_id: 3,
    },
    {
        id: 12,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Second Semester",
        parent_id: 3,
    },
    {
        id: 13,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "First Semester",
        parent_id: 4,
    },
    {
        id: 14,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Second Semester",
        parent_id: 4,
    },
    {
        id: 15,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "First Semester",
        parent_id: 5,
    },
    {
        id: 16,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Second Semester",
        parent_id: 5,
    },
    {
        id: 17,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "First Semester",
        parent_id: 6,
    },
    {
        id: 18,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Second Semester",
        parent_id: 6,
    },
    {
        id: 19,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "First Subject",
        parent_id: 8,
    },
    {
        id: 20,
        public: true,
        by_admin: true,
        type: DeckType.PACKAGE_DECK,
        title: "Second Subject",
        parent_id: 8,
    },
    {
        id: 21,
        public: false,
        by_admin: true,
        type: DeckType.CARDS_DECK,
        title: "First Section",
        parent_id: 19,
    },
    {
        id: 22,
        public: false,
        by_admin: true,
        type: DeckType.CARDS_DECK,
        title: "Second Section",
        parent_id: 19,
    },
];

const cards: Prisma.CardCreateManyInput[] = [
    {
        id: 1,
        type: CardType.BASIC,
        data: { text: "Hello from the first card" },
        deck_id: 21,
        order: 1,
    },
    {
        id: 2,
        type: CardType.BASIC,
        data: { text: "Hello from the second card" },
        deck_id: 21,
        order: 2,
    },
    {
        id: 3,
        type: CardType.BASIC,
        data: { text: "Hello from the first of section 1" },
        deck_id: 22,
        order: 1,
    },
];

async function main() {
    const fakerRounds = 10;
    console.log("Seeding ...");
    /// --------- Users ---------------
    console.log("   Seeding Users ...");
    await prisma.user.createMany({ data: users, skipDuplicates: true });
    console.log("   Seeding Decks ...");
    await prisma.deck.createMany({ data: decks, skipDuplicates: true });
    console.log("   Seeding Cards ...");
    await prisma.card.createMany({ data: cards, skipDuplicates: true });
}

main()
    .catch((e) => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
