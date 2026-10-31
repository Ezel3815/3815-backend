-- MCQ question bank: subjects -> collections -> questions.
CREATE TABLE `McqSubject` (
    `id` VARCHAR(64) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `published` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `McqSubject_published_order_idx`(`published`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `McqCollection` (
    `id` VARCHAR(64) NOT NULL,
    `subject_id` VARCHAR(64) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `title_en` VARCHAR(255) NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `published` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `McqCollection_subject_id_order_idx`(`subject_id`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `McqQuestion` (
    `id` VARCHAR(64) NOT NULL,
    `subject_id` VARCHAR(64) NOT NULL,
    `collection_id` VARCHAR(64) NOT NULL,
    `text` TEXT NOT NULL,
    `options` JSON NOT NULL,
    `correct` JSON NOT NULL,
    `explanation` TEXT NULL,
    `key_points` JSON NULL,
    `exam_label` VARCHAR(64) NULL,
    `source` VARCHAR(255) NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `published` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `McqQuestion_collection_id_order_idx`(`collection_id`, `order`),
    INDEX `McqQuestion_subject_id_idx`(`subject_id`),
    INDEX `McqQuestion_published_idx`(`published`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `McqCollection` ADD CONSTRAINT `McqCollection_subject_id_fkey`
    FOREIGN KEY (`subject_id`) REFERENCES `McqSubject`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `McqQuestion` ADD CONSTRAINT `McqQuestion_subject_id_fkey`
    FOREIGN KEY (`subject_id`) REFERENCES `McqSubject`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `McqQuestion` ADD CONSTRAINT `McqQuestion_collection_id_fkey`
    FOREIGN KEY (`collection_id`) REFERENCES `McqCollection`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
