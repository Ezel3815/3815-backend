-- Notification analytics (device-reported lifecycle records).
CREATE TABLE IF NOT EXISTS `NotificationEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `client_id` VARCHAR(64) NOT NULL,
    `user_id` INTEGER NOT NULL,
    `notification_type` VARCHAR(40) NOT NULL,
    `notification_pool` VARCHAR(40) NOT NULL,
    `message` TEXT NOT NULL,
    `sent_at` DATETIME(3) NOT NULL,
    `opened_at` DATETIME(3) NULL,
    `app_opened_after_notification` BOOLEAN NOT NULL DEFAULT false,
    `studied_after_notification` BOOLEAN NOT NULL DEFAULT false,
    `study_session_started_at` DATETIME(3) NULL,
    `cards_completed_after_notification` INTEGER NOT NULL DEFAULT 0,
    `notification_converted_to_study` BOOLEAN NOT NULL DEFAULT false,
    `challenge_id` INTEGER NULL,
    `friend_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `NotificationEvent_user_id_client_id_key`(`user_id`, `client_id`),
    INDEX `NotificationEvent_user_id_sent_at_idx`(`user_id`, `sent_at`),
    INDEX `NotificationEvent_notification_pool_sent_at_idx`(`notification_pool`, `sent_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
