import { Injectable, Logger } from "@nestjs/common";
import { User } from "@prisma/client";
import { log } from "console";
import e from "express";
import { PrismaService } from "nestjs-prisma";
import { CreateCodeDto } from "src/dtos/codes/create-code.dto";
import { CreateMultiCodeDto } from "src/dtos/codes/create-multi-code.dto";
import { UpdateCodeDto } from "src/dtos/codes/update-code.dto";
import { FindQueryDto } from "src/dtos/find-query.dto";
import { generateRandomCode } from "src/utils/code-generation.utils";
import { Parser } from 'json2csv';
import { GenerateBadRequestException } from "src/exception/bad-request.exception";
import { invalidateHierarchy } from "src/utils/hierarchy-cache";

@Injectable()
export class CodesService {
    constructor(private prismaService: PrismaService) {}

    async create(createDeckDto: CreateCodeDto) {
        return await this.prismaService.code.create({
            data: {
                code: createDeckDto.code ?? generateRandomCode(8),
                decks: {
                    createMany: {
                        data: createDeckDto.decks_ids.map((id) => ({
                            deck_id: id,
                        })),
                    },
                },
            },
            include: {
                decks: { include: { deck: true } },
            },
        });
    }

    async createMultiCode(createDeckDto: CreateMultiCodeDto) {
        const count = createDeckDto.count ?? 1;
        const length = createDeckDto.length ?? 8;
      
        const codeValues: { code: string }[] = [];
        const deckRelations: { code_id: string; deck_id: number }[] = [];
      
        for (const deckId of createDeckDto.decks_ids) {
          for (let i = 0; i < count; i++) {
            const code = generateRandomCode(length);
            codeValues.push({ code });
            deckRelations.push({code_id: code, deck_id: deckId });
          }
        }
      
        const allCodes = codeValues.map(c => c.code);
      
        // 🔍 Step 1: Find existing codes
        const existingCodes = await this.prismaService.code.findMany({
          where: { code: { in: allCodes } },
          select: { code: true },
        });

        new  Logger('adfsd').log(existingCodes);
        const existingCodeSet = new Set(existingCodes.map(e => e.code));
      
        // ✂️ Step 2: Remove existing codes from both arrays
        const filteredCodeValues = codeValues.filter(c => !existingCodeSet.has(c.code));
       const filteredDeckRelations = deckRelations.filter(r => !existingCodeSet.has(r.code_id));
      

        const uniqueFilteredCodeValues = filteredCodeValues.filter(
            (item, index, self) =>
              index === self.findIndex((t) => t.code === item.code)
          );


          const uniqueFilteredDeckRelations = filteredDeckRelations.filter(
            (item, index, self) =>
              index === self.findIndex((t) => t.code_id === item.code_id)
          );

        // ⚡ Step 3: Create only new codes
        await this.prismaService.code.createMany({
          data: uniqueFilteredCodeValues,
          
        });
      
        // 📥 Step 4: Fetch inserted codes to get their IDs
        const createdCodes = await this.prismaService.code.findMany({
          where: { code: { in: uniqueFilteredCodeValues.map(c => c.code) } },
        });
      
        const codeMap = new Map(createdCodes.map(c => [c.code, c.id]));
      
        // 🔗 Step 5: Create deck-code links
        const deckOnCodeEntries = uniqueFilteredDeckRelations.map(rel => ({
          deck_id: rel.deck_id,
          code_id: codeMap.get(rel.code_id)!,
        }));
      
        await this.prismaService.codeDeck.createMany({
          data: deckOnCodeEntries,
          skipDuplicates: true,
        });
      
        return createdCodes;
      }
      

      async getCodesAsCSV(): Promise<string> {
        const codes = await this.prismaService.code.findMany({
          include: {
            decks: { include: { deck: true } }, // join deck
          },
        });
      
        const flattened = codes.flatMap(code =>
          code.decks.map(relation => ({
            code_id: code.id,
            code: code.code,
            deck_name: relation.deck.title,
          }))
        );
      
        // Add counter column
        const withCounter = flattened.map((item, index) => ({
          index: index + 1,
          ...item,
        }));
      
        const fields = ['index', 'code_id', 'code', 'deck_name'];
        const parser = new Parser({ fields });
         return '\uFEFF' + parser.parse(withCounter); // add UTF-8 BOM
      }

    async read(findQueryDto: FindQueryDto) {
        const codes = await this.prismaService.code.findMany({
            skip: findQueryDto.skip,
            take: findQueryDto.limit,
            where: findQueryDto.filter ?? {},
            orderBy: findQueryDto.sort ?? { created_at: "desc" },
            include: { decks: { include: { deck: true } } },
        });

        const count = await this.prismaService.code.count({
            where: findQueryDto.filter ?? {},
        });

        return { count, data: codes };
    }

    async readOne(id: number) {
        const code = await this.prismaService.code.findUnique({
            where: { id },
            include: { decks: { include: { deck: true } } },
        });

        return code;
    }

    async update(id: number, updateCodeDto: UpdateCodeDto) {
        const code = await this.prismaService.code.update({
            where: {
                id,
            },
            data: {
                code: updateCodeDto.code,
                decks: {
                    deleteMany: {},
                    createMany: {
                        data: updateCodeDto.decks_ids.map((id) => ({
                            deck_id: id,
                        })),
                    },
                },
            },
            include: {
                decks: { include: { deck: true } },
            },
        });

        return code;
    }

    async delete(id: number) {
        await this.prismaService.$transaction([
            this.prismaService.codeDeck.deleteMany({
                where: {
                    code_id: id,
                },
            }),
            this.prismaService.code.delete({
                where: { id },
            }),
        ]);
    }

    async linkDecksByCode(user: User, rawCode: string) {
        const code = String(rawCode ?? "").trim();
        const codeEntity = await this.prismaService.code.findUnique({
            where: { code },
            include: { decks: true },
        });

        if (codeEntity == null) {
            // codes are deleted once used: a record of this user's use means they entered it before
            const used = await this.prismaService.codeRedemption.findUnique({
                where: { code_user_id: { code, user_id: user.id } },
            });
            if (used) GenerateBadRequestException(["لقد ادخلت الكود بالفعل"]);
            GenerateBadRequestException(["Code Does Not Exist"]);
        }

        const userDecks = await this.prismaService.userDeck.findMany({
            where: {
                user_id: user.id,
                deck_id: { in: codeEntity.decks.map((deck) => deck.deck_id) },
            },
        });
        const have = new Set(userDecks.map((ud) => ud.deck_id));
        const toAdd = codeEntity.decks
            .filter((cd) => !have.has(cd.deck_id))
            .map((cd) => cd.deck_id);

        // all-or-nothing: the decks, the "used" record and the code's removal go together
        await this.prismaService.$transaction([
            this.prismaService.userDeck.createMany({
                data: toAdd.map((id) => ({
                    user_id: user.id,
                    deck_id: id,
                    editable: false,
                    sharable: false,
                })),
                skipDuplicates: true,
            }),
            this.prismaService.codeRedemption.upsert({
                where: { code_user_id: { code, user_id: user.id } },
                create: { code, user_id: user.id },
                update: {},
            }),
            this.prismaService.codeDeck.deleteMany({
                where: { code_id: codeEntity.id },
            }),
            this.prismaService.code.deleteMany({ where: { id: codeEntity.id } }),
        ]);

        // The deck list is cached per user for 60s: without this the new subject
        // did not show up until the cache expired (users had to leave and re-enter).
        invalidateHierarchy(user.id);
    }
}
