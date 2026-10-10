# Use the official Node.js runtime as a base image
FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npx prisma generate \
    && grep -q "study_year" node_modules/.prisma/client/index.d.ts \
    && echo "OK: Prisma client includes study_year"

# Compile at BUILD time, not at boot. Before, `nest start` compiled every time
# the container started; if that compile produced nothing the app crashed with
# "Cannot find module '/app/dist/main'". Now a compile error fails the deploy
# with a clear log (the previous version keeps running) and boot is much faster.
RUN npm run build && ls dist

# Sync the database to prisma/schema.prisma, then start the app.
# Earlier deploys never ran migrations, so the DB may have no migration
# history and `migrate deploy` could block every deploy. `db push` adds what
# is missing (xp column, UserAchievement, ActivityEvent) and refuses
# destructive changes; if it can't run, the server still starts and the
# reason is in the logs.
# The compiled entry is dist/src/main.js (prisma/ is compiled too); fall back
# to dist/main.js if the layout ever changes.
ENTRYPOINT ["sh", "-c", "npx prisma db push --skip-generate || echo 'WARNING: prisma db push failed - starting anyway'; if [ -f dist/src/main.js ]; then exec node dist/src/main.js; else exec node dist/main.js; fi"]
