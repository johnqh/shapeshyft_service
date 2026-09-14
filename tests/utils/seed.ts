import { db, tables } from "./db.js";
import { TEST_ENCRYPTION } from "./fakes.js";
import { createProjectApiKeys } from "../../src/lib/api-key.js";

export const TEST_UID = "service-test-uid";
const projectKeys = createProjectApiKeys(TEST_ENCRYPTION);

/** A user, their personal entity (manager membership), and one project with an API key. */
export async function seedEntityWithProject() {
  await db.insert(tables.users).values({
    firebase_uid: TEST_UID,
    email: "service-test@example.com",
  });

  // Entity slugs are at most 12 characters (entitySlugParamSchema)
  const slug = `svc${Math.random().toString(36).slice(2, 10)}`;
  const [entity] = await db
    .insert(tables.entities)
    .values({
      entity_slug: slug,
      entity_type: "personal",
      display_name: "Test",
    })
    .returning();
  await db.insert(tables.entityMembers).values({
    entity_id: entity!.id,
    user_id: TEST_UID,
    role: "manager",
  });

  const { key, prefix } = projectKeys.generateProjectApiKey();
  const { encrypted, iv } = projectKeys.encryptProjectApiKey(key);
  const [project] = await db
    .insert(tables.projects)
    .values({
      entity_id: entity!.id,
      project_name: "svc-project",
      display_name: "Service Project",
      encrypted_api_key: encrypted,
      api_key_iv: iv,
      api_key_prefix: prefix,
      api_key_created_at: new Date(),
    })
    .returning();

  return { entity: entity!, project: project!, projectApiKey: key };
}
