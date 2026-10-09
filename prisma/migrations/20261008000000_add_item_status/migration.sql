-- Аддитивное изменение: старый клиент продолжает работать с isCompleted.
CREATE TYPE "ItemStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');
ALTER TABLE "Item" ADD COLUMN "status" "ItemStatus" NOT NULL DEFAULT 'NOT_STARTED';
UPDATE "Item" SET "status" = 'COMPLETED' WHERE "isCompleted";
-- Состояние блока выводится из подпунктов, как и отметка выполнения.
UPDATE "Item" AS parent SET "status" = CASE
  WHEN NOT EXISTS (SELECT 1 FROM "Item" child WHERE child."parentId" = parent.id AND NOT child."isCompleted") THEN 'COMPLETED'::"ItemStatus"
  WHEN EXISTS (SELECT 1 FROM "Item" child WHERE child."parentId" = parent.id AND child."isCompleted") THEN 'IN_PROGRESS'::"ItemStatus"
  ELSE 'NOT_STARTED'::"ItemStatus"
END WHERE EXISTS (SELECT 1 FROM "Item" child WHERE child."parentId" = parent.id);
