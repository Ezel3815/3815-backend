-- Catch-up migration: adds User columns and the Follow table that were
-- already present in schema.prisma (applied to real environments via
-- `prisma db push`) but were never captured as migration files.
ALTER TABLE `User` ADD COLUMN `username` VARCHAR(191) NULL;
ALTER TABLE `User` ADD COLUMN `avatar_hair` VARCHAR(191) NULL;
ALTER TABLE `User` ADD COLUMN `avatar_hair_color` VARCHAR(191) NULL;
ALTER TABLE `User` ADD COLUMN `avatar_skin_color` VARCHAR(191) NULL;
ALTER TABLE `User` ADD COLUMN `avatar_clothing_color` VARCHAR(191) NULL;
ALTER TABLE `User` ADD COLUMN `avatar_glasses` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `User` ADD COLUMN `current_streak` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `User` ADD COLUMN `last_study_date` DATETIME(3) NULL;
ALTER TABLE `User` ADD COLUMN `fcm_token` VARCHAR(191) NULL;
ALTER TABLE `User` ADD COLUMN `quest_partner_id` INTEGER NULL;

CREATE UNIQUE INDEX `User_username_key` ON `User`(`username`);

CREATE TABLE IF NOT EXISTS `Follow` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `followerId` INTEGER NOT NULL,
    `followingId` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Follow_followerId_followingId_key`(`followerId`, `followingId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Follow` ADD CONSTRAINT `Follow_followerId_fkey` FOREIGN KEY (`followerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Follow` ADD CONSTRAINT `Follow_followingId_fkey` FOREIGN KEY (`followingId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS `ActivityReaction` (
    `event_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ActivityReaction_user_id_idx`(`user_id`),
    PRIMARY KEY (`event_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ActivityComment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `event_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,
    `text` VARCHAR(300) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ActivityComment_event_id_idx`(`event_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ActivityReaction` ADD CONSTRAINT `ActivityReaction_event_id_fkey` FOREIGN KEY (`event_id`) REFERENCES `ActivityEvent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ActivityReaction` ADD CONSTRAINT `ActivityReaction_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ActivityComment` ADD CONSTRAINT `ActivityComment_event_id_fkey` FOREIGN KEY (`event_id`) REFERENCES `ActivityEvent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ActivityComment` ADD CONSTRAINT `ActivityComment_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ActivityEvent` ADD COLUMN `target_user_id` INTEGER NULL;
CREATE INDEX `ActivityEvent_target_user_id_idx` ON `ActivityEvent`(`target_user_id`);
ALTER TABLE `ActivityEvent` ADD CONSTRAINT `ActivityEvent_target_user_id_fkey` FOREIGN KEY (`target_user_id`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
