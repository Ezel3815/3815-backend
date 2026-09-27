-- Mosaic progression: user timezone + season / day ledger / pieces.
ALTER TABLE `User` ADD COLUMN `timezone` VARCHAR(64) NULL;

CREATE TABLE IF NOT EXISTS `MosaicSeason` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `artwork_id` VARCHAR(64) NOT NULL,
    `timezone` VARCHAR(64) NOT NULL,
    `start_date` VARCHAR(10) NOT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,

    UNIQUE INDEX `MosaicSeason_user_id_artwork_id_key`(`user_id`, `artwork_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `MosaicDay` (
    `user_id` INTEGER NOT NULL,
    `artwork_id` VARCHAR(64) NOT NULL,
    `day_index` INTEGER NOT NULL,
    `local_date` VARCHAR(10) NOT NULL,
    `reviews` INTEGER NOT NULL DEFAULT 0,
    `mastered` INTEGER NOT NULL DEFAULT 0,
    `chapter_done` BOOLEAN NOT NULL DEFAULT false,
    `scheduled_released` INTEGER NOT NULL DEFAULT 0,
    `catchup_released` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`user_id`, `artwork_id`, `day_index`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `MosaicPiece` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `user_id` INTEGER NOT NULL,
    `artwork_id` VARCHAR(64) NOT NULL,
    `slot` INTEGER NOT NULL,
    `piece_id` INTEGER NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `source_key` VARCHAR(64) NOT NULL,
    `season_day` INTEGER NOT NULL,
    `earned_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revealed_at` DATETIME(3) NULL,

    UNIQUE INDEX `MosaicPiece_user_id_artwork_id_slot_key`(`user_id`, `artwork_id`, `slot`),
    UNIQUE INDEX `MosaicPiece_user_id_artwork_id_piece_id_key`(`user_id`, `artwork_id`, `piece_id`),
    UNIQUE INDEX `MosaicPiece_user_id_artwork_id_source_key_key`(`user_id`, `artwork_id`, `source_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `MosaicSeason` ADD CONSTRAINT `MosaicSeason_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `MosaicDay` ADD CONSTRAINT `MosaicDay_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `MosaicPiece` ADD CONSTRAINT `MosaicPiece_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
