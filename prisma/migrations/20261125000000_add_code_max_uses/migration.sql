-- Code.max_uses: NULL = normal single-use code; a number = VIP code usable by that many students.
ALTER TABLE `Code` ADD COLUMN `max_uses` INTEGER NULL,
    ADD COLUMN `used_count` INTEGER NOT NULL DEFAULT 0;
