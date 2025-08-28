// server.js
import Fastify from "fastify";
import OpenAI from "openai";
import db from "./db/postgres.js"; // your pg Pool wrapper
import pg from "pg";

const fastify = Fastify({ logger: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

fastify.get("/search", async (request, reply) => {
    const startTime = Date.now();

    try {
        const {
            query = "",
            tags = "",
            subject = "",
            examboard = "",
            level = "",
            type = "",
            limit = 20,
            offset = 0,
            sort = "averagerating:desc",
            fuzzy = "true",
            semantic = "false",
        } = request.query;

        const parsedTags = tags ? tags.toString().split(",") : [];

        // Build WHERE filters
        const filters = [];
        const values = [];
        let paramIndex = 1;

        if (parsedTags.length > 0) {
            filters.push(
                parsedTags
                    .map((tag) => `"tags" @> ARRAY[$${paramIndex++}]`)
                    .join(" AND ")
            );
            values.push(...parsedTags);
        }
        if (subject) {
            filters.push(`"subject" = $${paramIndex++}`);
            values.push(subject);
        }
        if (examboard) {
            filters.push(`"examboard" = $${paramIndex++}`);
            values.push(examboard);
        }
        if (level) {
            filters.push(`"level" = $${paramIndex++}`);
            values.push(level);
        }
        if (type) {
            filters.push(`"type" = $${paramIndex++}`);
            values.push(type);
        }

        const whereClause =
            filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

        // Sorting
        const [sortField, sortDir] = sort.toString().split(":");
        const validSortDir =
            sortDir === "asc" || sortDir === "desc" ? sortDir : "desc";
        const orderBy = sortField
            ? `"${sortField}" ${validSortDir}`
            : `"averagerating" DESC`;

        let rows = [];

        // --- Search Strategy ---
        if (semantic === "true" && query) {
            // Semantic search with pgvector
            const embeddingResponse = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: query,
            });
            const embedding = embeddingResponse.data[0].embedding;
            const embeddingLiteral = `[${embedding.join(",")}]`;

            const sql = `
        SELECT id, title, description, "averagerating", subject, "examboard", level, type,
               1 - (embedding <-> $${paramIndex}) AS semantic_score
        FROM resources
        ${whereClause}
        ORDER BY semantic_score DESC, ${orderBy}
        LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2};
      `;
            values.push(embeddingLiteral, limit, offset);

            const result = await db.query(sql, values);
            rows = result.rows;
        } else if (query) {
            // Full-text + optional fuzzy
            let searchCondition = `"search_tsv" @@ plainto_tsquery('english', $${paramIndex})`;
            values.push(query);
            paramIndex++;

            if (fuzzy === "true") {
                searchCondition = `(${searchCondition} OR "title" % $${paramIndex})`;
                values.push(query);
                paramIndex++;
            }

            const sql = `
        SELECT id, title, description, "averagerating", subject, "examboard", level, type,
               ts_rank("search_tsv", plainto_tsquery('english', $1)) AS rank,
               similarity("title", $1) AS fuzzy_score
        FROM "resources"
        ${whereClause ? whereClause + " AND " : "WHERE "} ${searchCondition}
        ORDER BY rank DESC, fuzzy_score DESC, ${orderBy}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
      `;
            values.push(limit, offset);

            const result = await db.query(sql, values);
            rows = result.rows;
        } else {
            // No query: just return filtered + sorted
            const sql = `
        SELECT id, title, description, "averagerating", subject, "examboard", level, type
        FROM "resources"
        ${whereClause}
        ORDER BY ${orderBy}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1};
      `;
            values.push(limit, offset);

            const result = await db.query(sql, values);
            rows = result.rows;
        }

        const processingTimeMs = Date.now() - startTime;

        return {
            hits: rows,
            totalHits: rows.length, // could run COUNT(*) if you want exact totals
            processingTimeMs,
            fuzzyEnabled: fuzzy === "true",
            semanticEnabled: semantic === "true",
        };
    } catch (error) {
        request.log.error(error);
        return reply.code(500).send({
            error: "An error occurred while searching",
            message: error.message,
        });
    }
});

/* fastify.get("/migrate", async (request, reply) => {
    try {
        // Connect to old Postgres
        const oldPool = new pg.Pool({
            connectionString: process.env.OLD_POSTGRES_URL,
            ssl: { rejectUnauthorized: false },
        });

        fastify.log.info("Fetching resources from old database...");
        const { rows: oldResources } = await oldPool.query(
            `SELECT * FROM "Resource"`
        );

        console.log(oldResources);

        fastify.log.info(`Found ${oldResources.length} resources to migrate`);

        for (const resource of oldResources) {
            const text = `${resource.title ?? ""}. ${
                resource.description ?? ""
            }. ${resource.examBoard ?? ""}. ${resource.subject ?? ""}.`;

            // Generate embedding
            let embedding = null;
            try {
                const response = await openai.embeddings.create({
                    model: "text-embedding-3-small",
                    input: text,
                });
                embedding = response.data[0].embedding;
            } catch (err) {
                fastify.log.error(
                    `Embedding failed for resource ${resource.id}`,
                    err
                );
            }

            // Convert embedding to Postgres vector literal
            const embeddingLiteral = embedding
                ? `[${embedding.join(",")}]`
                : null;

            // Insert into new DB
            await db.query(
                `
  INSERT INTO resources
    (id, "resourceid", type, title, level, subject, "examboard", link, author, "averagerating", description, embedding)
  VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  ON CONFLICT (id) DO NOTHING;
`,
                [
                    resource.id,
                    resource.resourceId,
                    resource.type,
                    resource.title,
                    resource.level,
                    resource.subject,
                    resource.examBoard,
                    resource.link,
                    resource.author,
                    resource.averageRating,
                    resource.description,
                    embeddingLiteral,
                ]
            );

            fastify.log.info(`✅ Migrated resource ${resource.id}`);
        }

        await oldPool.end();

        return { success: true, migrated: oldResources.length };
    } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({
            error: "Migration failed",
            message: err.message,
        });
    }
}); */

// Start server
const start = async () => {
    try {
        await fastify.listen({
            port: process.env.PORT || 3000,
            host: "0.0.0.0",
        });
        fastify.log.info(
            `🚀 Server running on http://localhost:${process.env.PORT || 3000}`
        );
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
