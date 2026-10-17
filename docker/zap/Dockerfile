FROM node:24@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN npx playwright install --with-deps chromium
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate
COPY src ./src
COPY public ./public
COPY messages ./messages
COPY test ./test
COPY scripts ./scripts
COPY config/zap ./config/zap
COPY tsconfig.json next-env.d.ts next.config.ts postcss.config.mjs ./
COPY playwright.config.ts playwright.zap.config.ts vitest.config.ts vitest.integration.config.ts vitest.security.config.ts ./
RUN node scripts/zap/build.mjs
CMD ["node", "-e", "setInterval(()=>{},1000)"]
