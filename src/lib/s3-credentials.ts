/**
 * @file s3-credentials.ts
 * @description Выбор учётных данных для S3: федерация OIDC или статические ключи.
 *
 * Зачем отдельный модуль: `s3.ts` создаёт клиента прямо на импорте и тянет за
 * собой AWS SDK, поэтому проверить в нём выбор credentials тестом трудно. Здесь
 * та же логика в виде чистой функции от окружения.
 *
 * Как это работает на Vercel: платформа выдаёт функции подписанный OIDC-токен,
 * AWS обменивает его через `AssumeRoleWithWebIdentity` на временные креды. Тот
 * же приём, что уже используется для Cloud Run в `gcp-auth.ts`, — долгоживущих
 * ключей на этом пути нет вовсе. Локально OIDC отсутствует, поэтому остаётся
 * статический ключ dev-пользователя.
 */

import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";

/** Форма ARN роли IAM. Проверяем до первого запроса, см. ниже. */
const ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/;

/**
 * Ровно те переменные, которые нужны выбору. Отдельный тип, а не
 * `NodeJS.ProcessEnv`: тот в этом проекте требует `NODE_ENV`, к делу не
 * относящийся, и заставлял бы каждый вызов тащить лишнее поле.
 */
export interface S3CredentialEnv {
  // Индексная сигнатура нужна, чтобы принимать сам `process.env`: без неё
  // TypeScript считает тип «слабым» и отвергает объект с одними лишь
  // необязательными полями.
  readonly [key: string]: string | undefined;
  readonly S3_ROLE_ARN?: string;
  readonly S3_ACCESS_KEY_ID?: string;
  readonly S3_SECRET_ACCESS_KEY?: string;
}

/**
 * Возвращает credentials для `S3Client` по переменным окружения.
 *
 * Роль имеет приоритет над статическими ключами намеренно. Во время перехода
 * заданы оба набора, и приоритет решает, что именно проверяется деплоем: если
 * бы выигрывали ключи, федерацию нельзя было бы испытать, не удалив их — то
 * есть не оставшись без пути отката. Откат здесь — удалить `S3_ROLE_ARN`.
 *
 * Неверный ARN — это отказ, а не молчаливый откат на ключи. Иначе опечатка в
 * ARN давала бы работающее приложение, про которое все считают, что оно уже
 * ушло с долгоживущих ключей: контроль, который выглядит как защита и ею не
 * является.
 */
export function resolveS3Credentials(
  env: S3CredentialEnv,
): S3ClientConfig["credentials"] {
  const roleArn = env.S3_ROLE_ARN;

  if (roleArn) {
    if (!ROLE_ARN_PATTERN.test(roleArn)) {
      throw new Error(
        "S3_ROLE_ARN не похож на ARN роли IAM: ожидается arn:aws:iam::<12 цифр>:role/<имя>",
      );
    }
    return awsCredentialsProvider({ roleArn });
  }

  return {
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
  };
}
