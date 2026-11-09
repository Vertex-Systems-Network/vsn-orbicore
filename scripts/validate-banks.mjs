import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const errors = [];
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function matchesType(value, type) {
  if (Array.isArray(type)) return type.some((item) => matchesType(value, item));
  return type === "object" ? isObject(value)
    : type === "array" ? Array.isArray(value)
      : type === "integer" ? Number.isInteger(value)
        : type === "number" ? typeof value === "number" && Number.isFinite(value)
          : type === "null" ? value === null
            : typeof value === type;
}

function validate(schema, value, path) {
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: value is not in enum`);
  if (schema.pattern && (typeof value !== "string" || !new RegExp(schema.pattern).test(value))) errors.push(`${path}: does not match ${schema.pattern}`);
  if (schema.minLength && typeof value === "string" && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
  if (schema.minItems && Array.isArray(value) && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
  if (schema.format === "date" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) errors.push(`${path}: invalid date`);
  if (schema.format === "uri") {
    try { const url = new URL(value); if (!url.protocol) throw new Error(); }
    catch { errors.push(`${path}: invalid URI`); }
  }
  if (!isObject(value)) return;
  for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: missing required property ${key}`);
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) errors.push(`${path}: unexpected property ${key}`);
  }
  for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
    if (key in value) validate(childSchema, value[key], `${path}.${key}`);
  }
  if (schema.additionalProperties && isObject(schema.additionalProperties)) {
    for (const [key, child] of Object.entries(value)) if (!(key in (schema.properties ?? {}))) validate(schema.additionalProperties, child, `${path}.${key}`);
  }
  if (schema.items && Array.isArray(value)) value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
}

async function jsonFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await jsonFiles(path));
    else if (entry.name.endsWith(".json")) files.push(path);
  }
  return files;
}

const definitions = [
  { schema: "flow", files: () => jsonFiles("knowledge-bank/flows"), records: (data) => [data] },
  { schema: "option", files: async () => ["knowledge-bank/options/options.json"], records: (data) => data.records },
  { schema: "system", files: async () => ["knowledge-bank/systems/systems.json"], records: (data) => data.records },
  { schema: "integration", files: async () => ["knowledge-bank/integrations/cpanel-uapi.json"], records: (data) => [data] },
  { schema: "research", files: async () => ["knowledge-bank/research/evidence.json"], records: (data) => data.records },
  { schema: "test-evidence", files: async () => ["knowledge-bank/test-evidence/evidence.json"], records: (data) => data.records },
];
const records = [];
for (const definition of definitions) {
  const schema = await readJson(`knowledge-bank/schemas/${definition.schema}.schema.json`);
  for (const file of await definition.files()) {
    const data = await readJson(file);
    for (const record of definition.records(data)) {
      validate(schema, record, `${file}#${record.id ?? "<missing-id>"}`);
      records.push({ record, file });
    }
  }
}

const ids = new Map();
for (const { record, file } of records) {
  if (ids.has(record.id)) errors.push(`${file}: duplicate id ${record.id} (also ${ids.get(record.id)})`);
  else ids.set(record.id, file);
}

const testIds = new Set(records.filter(({ file }) => file.includes("test-evidence/evidence.json")).map(({ record }) => record.id));
for (const { record, file } of records) {
  for (const testId of record.test_ids ?? []) {
    if (!testIds.has(testId)) errors.push(`${file}#${record.id}: unresolved test id ${testId}`);
  }
}

const backlog = await readJson("backlog/tasks.json");
const delivery = await readJson("knowledge-bank/backlog/delivery.json");
const tasksById = new Map();
for (const task of backlog.tasks ?? []) {
  if (tasksById.has(task.id)) errors.push(`backlog/tasks.json: duplicate task id ${task.id}`);
  tasksById.set(task.id, task);
}
const mappedTasks = new Set();
for (const epic of delivery.epics ?? []) {
  for (const taskId of epic.task_ids ?? []) {
    if (!tasksById.has(taskId)) errors.push(`knowledge-bank/backlog/delivery.json#${epic.id}: unresolved task id ${taskId}`);
    if (mappedTasks.has(taskId)) errors.push(`knowledge-bank/backlog/delivery.json: task ${taskId} appears in multiple epics`);
    mappedTasks.add(taskId);
  }
}
for (const task of backlog.tasks ?? []) {
  if (!mappedTasks.has(task.id)) errors.push(`backlog/tasks.json#${task.id}: missing epic mapping`);
  for (const dependency of task.dependencies ?? []) if (!tasksById.has(dependency)) errors.push(`backlog/tasks.json#${task.id}: unresolved dependency ${dependency}`);
  for (const testId of task.test_ids ?? []) if (!testIds.has(testId)) errors.push(`backlog/tasks.json#${task.id}: unresolved test id ${testId}`);
  for (const path of task.evidence_paths ?? []) if (!existsSync(path)) errors.push(`backlog/tasks.json#${task.id}: unresolved evidence path ${path}`);
}

for (const { record, file } of records) {
  for (const key of ["dependencies"]) {
    for (const dependency of record[key] ?? []) {
      if (/^(SYS|OPT|FLOW|INT|RES)-/.test(dependency) && !ids.has(dependency)) errors.push(`${file}#${record.id}: unresolved ${key} id ${dependency}`);
    }
  }
  for (const key of ["source_references", "evidence_references"]) {
    for (const reference of record[key] ?? []) {
      const localPath = reference.split("#", 1)[0];
      if (/^(docs|knowledge-bank|tests|apps|backlog)\//.test(localPath) && !existsSync(localPath)) errors.push(`${file}#${record.id}: unresolved path ${reference}`);
    }
  }
  if (record.mock_fixture && !existsSync(record.mock_fixture)) errors.push(`${file}#${record.id}: missing mock fixture ${record.mock_fixture}`);
}

if (errors.length) {
  console.error(errors.map((error) => `ERROR ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${records.length} knowledge-bank records against 6 JSON Schemas; bank IDs, test IDs, task IDs/dependencies, epic mappings, and local links resolve.`);
}
