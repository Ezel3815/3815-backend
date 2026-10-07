-- Deck.visible: false = hidden from non-admin users (admins always see it).
ALTER TABLE `Deck` ADD COLUMN `visible` BOOLEAN NOT NULL DEFAULT true;
