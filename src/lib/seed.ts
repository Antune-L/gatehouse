import type {
  AuditEntry,
  CellValue,
  ConnectionProfile,
  HistoryEntry,
  McpClient,
  QueueEntry,
  SavedQuery,
  SchemaTree,
  TableDef,
} from "./types";

// Deterministic PRNG so screenshots and grids are stable across runs.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const PROFILE_COLORS = {
  red: "#f26d6d",
  orange: "#f2994a",
  yellow: "#f2c94c",
  green: "#3ac47d",
  blue: "#4a9bf2",
  purple: "#9b6df2",
  pink: "#f26dbb",
};

export const seedProfiles: ConnectionProfile[] = [
  {
    id: "p_acme_local",
    name: "locale",
    engine: "postgres",
    group: "Projet ACME",
    color: PROFILE_COLORS.green,
    host: "localhost",
    port: 5432,
    user: "acme",
    database: "acme_dev",
    environment: "local",
    ssl: false,
    sshTunnel: false,
    sshHost: "",
    sshPort: 22,
    sshUser: "",
    sshKeyPath: "",
    readOnly: false,
    agentAccess: true,
    readOnlyBadge: "best-effort",
    state: "connected",
    savePassword: true,
  },
  {
    id: "p_acme_staging",
    name: "staging",
    engine: "mysql",
    group: "Projet ACME",
    color: PROFILE_COLORS.orange,
    host: "db-stg.acme.internal",
    port: 3306,
    user: "acme_ro",
    database: "acme_staging",
    environment: "staging",
    ssl: true,
    sshTunnel: false,
    sshHost: "",
    sshPort: 22,
    sshUser: "",
    sshKeyPath: "",
    readOnly: false,
    agentAccess: true,
    readOnlyBadge: "best-effort",
    state: "reconnecting",
    savePassword: true,
  },
  {
    id: "p_acme_prod",
    name: "production",
    engine: "postgres",
    group: "Projet ACME",
    color: PROFILE_COLORS.red,
    host: "db.acme.internal",
    port: 5432,
    user: "acme_ro",
    database: "acme_prod",
    environment: "production",
    ssl: true,
    sshTunnel: false,
    sshHost: "",
    sshPort: 22,
    sshUser: "",
    sshKeyPath: "",
    readOnly: false,
    agentAccess: false,
    readOnlyBadge: "guaranteed",
    state: "connected",
    savePassword: true,
  },
  {
    id: "p_notes",
    name: "notes.sqlite",
    engine: "sqlite",
    group: "Perso",
    color: PROFILE_COLORS.blue,
    host: "",
    port: 0,
    user: "",
    database: "~/notes.db",
    environment: "local",
    ssl: false,
    sshTunnel: false,
    sshHost: "",
    sshPort: 22,
    sshUser: "",
    sshKeyPath: "",
    readOnly: false,
    agentAccess: true,
    readOnlyBadge: "guaranteed",
    state: "connected",
    savePassword: false,
  },
];

const FIRST = [
  "Alice", "Bob", "Carla", "Diego", "Emma", "Farid", "Grace", "Hugo",
  "Ines", "Jonas", "Kira", "Louis", "Maya", "Nils", "Olga", "Pablo",
  "Quinn", "Rosa", "Sami", "Tara", "Umar", "Vera", "Wassim", "Xena",
  "Yara", "Zack",
];
const LAST = [
  "Martin", "Nguyen", "Silva", "Kowalski", "Rossi", "Haddad", "Chen",
  "Dubois", "Okoro", "Ivanov", "Yamada", "Costa", "Meyer", "Fischer",
];
const PRODUCTS = [
  ["Aurora Desk Lamp", "Lighting", 4900], ["Basalt Mug", "Kitchen", 1600],
  ["Cirrus Backpack", "Travel", 8900], ["Delta Notebook", "Office", 1200],
  ["Ember Kettle", "Kitchen", 5400], ["Fjord Water Bottle", "Travel", 2400],
  ["Grove Planter", "Home", 3100], ["Halo Headphones", "Audio", 14900],
  ["Iris Keyboard", "Office", 9900], ["Juno Mouse", "Office", 4500],
  ["Kelp Soap Bar", "Bath", 800], ["Lumen Candle", "Home", 1900],
  ["Meridian Watch", "Wearable", 21900], ["Nomad Charger", "Tech", 3900],
  ["Onyx Pen Set", "Office", 2900], ["Pebble Speaker", "Audio", 6900],
];
const STATUSES = ["pending", "paid", "shipped", "delivered", "refunded"];
const CATEGORIES = [
  "Lighting", "Kitchen", "Travel", "Office", "Home", "Audio", "Bath",
  "Wearable", "Tech",
];

function pad(n: number, width = 2) {
  return String(n).padStart(width, "0");
}
function isoDate(daysAgo: number, rnd: () => number) {
  const base = new Date("2026-07-17T09:00:00Z").getTime();
  const t = base - daysAgo * 86400000 - Math.floor(rnd() * 86400000);
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate()
  )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export interface SeedTableData {
  columns: string[];
  rows: CellValue[][];
}

function buildData(): Record<string, SeedTableData> {
  const rnd = lcg(20260717);

  const users: CellValue[][] = [];
  for (let i = 1; i <= 84; i++) {
    const first = FIRST[Math.floor(rnd() * FIRST.length)];
    const last = LAST[Math.floor(rnd() * LAST.length)];
    users.push([
      i,
      `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      `${first} ${last}`,
      i % 11 === 0 ? null : `+33 6 ${pad(Math.floor(rnd() * 100))} ${pad(
        Math.floor(rnd() * 100)
      )} ${pad(Math.floor(rnd() * 100))}`,
      rnd() > 0.5,
      i % 7 === 0 ? "" : ["FR", "DE", "IT", "ES", "PT"][Math.floor(rnd() * 5)],
      isoDate(Math.floor(rnd() * 400) + 5, rnd),
    ]);
  }

  const categories: CellValue[][] = CATEGORIES.map((c, i) => [
    i + 1,
    c,
    c.toLowerCase(),
    i === 0 ? null : ((i % 3) + 1),
  ]);

  const products: CellValue[][] = PRODUCTS.map((p, i) => {
    const catId = CATEGORIES.indexOf(p[1] as string) + 1;
    return [
      i + 1,
      p[0],
      catId || 1,
      p[2],
      Math.floor(rnd() * 240),
      rnd() > 0.15,
      `SKU-${pad(1000 + i, 4)}`,
    ];
  });

  const orders: CellValue[][] = [];
  for (let i = 1; i <= 240; i++) {
    const userId = 1 + Math.floor(rnd() * users.length);
    const status = STATUSES[Math.floor(rnd() * STATUSES.length)];
    orders.push([
      i,
      userId,
      status,
      Math.floor(rnd() * 40000) + 1200,
      status === "pending" ? null : isoDate(Math.floor(rnd() * 200), rnd),
      isoDate(Math.floor(rnd() * 200) + 1, rnd),
    ]);
  }

  const orderItems: CellValue[][] = [];
  let oiId = 1;
  for (let o = 1; o <= 240; o++) {
    const n = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const prod = 1 + Math.floor(rnd() * products.length);
      orderItems.push([
        oiId++,
        o,
        prod,
        1 + Math.floor(rnd() * 3),
        products[prod - 1][3],
      ]);
    }
  }

  const COMPANIES = [
    "Northwind SARL", "Globex", "Initech", "Umbrella", "Soylent", "Acme Corp",
    "Hooli", "Vandelay", "Stark Industries", "Wayne Enterprises", "Wonka",
    "Cyberdyne", "Tyrell", "Aperture", "Massive Dynamic", "Pied Piper",
  ];
  const customers: CellValue[][] = [];
  for (let i = 1; i <= 42; i++) {
    const company = COMPANIES[Math.floor(rnd() * COMPANIES.length)];
    customers.push([
      i,
      `${company}${i}`,
      `contact@${company.toLowerCase().replace(/[^a-z]/g, "")}.com`,
      ["FR", "DE", "IT", "ES", "PT", "US"][Math.floor(rnd() * 6)],
      i % 9 === 0 ? null : "net30",
      isoDate(Math.floor(rnd() * 500) + 10, rnd),
    ]);
  }

  const INV_STATUS = ["draft", "sent", "paid", "overdue", "void"];
  const invoices: CellValue[][] = [];
  for (let i = 1; i <= 128; i++) {
    const orderId = 1 + Math.floor(rnd() * orders.length);
    const status = INV_STATUS[Math.floor(rnd() * INV_STATUS.length)];
    invoices.push([
      i,
      `INV-2026-${pad(4000 + i, 4)}`,
      orderId,
      Math.floor(rnd() * 60000) + 1500,
      status,
      status === "paid" ? isoDate(Math.floor(rnd() * 120), rnd) : null,
      isoDate(Math.floor(rnd() * 200) + 1, rnd),
    ]);
  }

  return {
    customers: {
      columns: [
        "id", "company", "email", "country_code", "terms", "created_at",
      ],
      rows: customers,
    },
    invoices: {
      columns: [
        "id", "reference", "order_id", "amount_cents", "status", "paid_at",
        "issued_at",
      ],
      rows: invoices,
    },
    users: {
      columns: [
        "id", "email", "full_name", "phone", "is_verified", "country_code",
        "created_at",
      ],
      rows: users,
    },
    categories: {
      columns: ["id", "name", "slug", "parent_id"],
      rows: categories,
    },
    products: {
      columns: [
        "id", "name", "category_id", "price_cents", "stock", "active", "sku",
      ],
      rows: products,
    },
    orders: {
      columns: [
        "id", "user_id", "status", "total_cents", "paid_at", "created_at",
      ],
      rows: orders,
    },
    order_items: {
      columns: ["id", "order_id", "product_id", "quantity", "unit_price_cents"],
      rows: orderItems,
    },
  };
}

export const seedTableData = buildData();

const usersTable: TableDef = {
  name: "users",
  kind: "table",
  schema: "public",
  rowCount: seedTableData.users.rows.length,
  columns: [
    { name: "id", type: "integer", nullable: false, primaryKey: true },
    { name: "email", type: "varchar", nullable: false, unique: true },
    { name: "full_name", type: "varchar", nullable: false },
    { name: "phone", type: "varchar", nullable: true },
    { name: "is_verified", type: "boolean", nullable: false, defaultValue: "false" },
    { name: "country_code", type: "varchar", nullable: true },
    { name: "created_at", type: "timestamp", nullable: false, defaultValue: "now()" },
  ],
  indexes: [
    { name: "users_pkey", columns: ["id"], unique: true },
    { name: "users_email_key", columns: ["email"], unique: true },
    { name: "users_country_idx", columns: ["country_code"], unique: false },
  ],
  triggers: [
    { name: "users_set_updated", timing: "BEFORE", event: "UPDATE" },
  ],
};

const categoriesTable: TableDef = {
  name: "categories",
  kind: "table",
  schema: "public",
  rowCount: seedTableData.categories.rows.length,
  columns: [
    { name: "id", type: "integer", nullable: false, primaryKey: true },
    { name: "name", type: "varchar", nullable: false },
    { name: "slug", type: "varchar", nullable: false, unique: true },
    {
      name: "parent_id",
      type: "integer",
      nullable: true,
      references: { table: "categories", column: "id" },
    },
  ],
  indexes: [{ name: "categories_pkey", columns: ["id"], unique: true }],
  triggers: [],
};

const productsTable: TableDef = {
  name: "products",
  kind: "table",
  schema: "public",
  rowCount: seedTableData.products.rows.length,
  columns: [
    { name: "id", type: "integer", nullable: false, primaryKey: true },
    { name: "name", type: "varchar", nullable: false },
    {
      name: "category_id",
      type: "integer",
      nullable: false,
      references: { table: "categories", column: "id" },
    },
    { name: "price_cents", type: "integer", nullable: false },
    { name: "stock", type: "integer", nullable: false, defaultValue: "0" },
    { name: "active", type: "boolean", nullable: false, defaultValue: "true" },
    { name: "sku", type: "varchar", nullable: false, unique: true },
  ],
  indexes: [
    { name: "products_pkey", columns: ["id"], unique: true },
    { name: "products_category_idx", columns: ["category_id"], unique: false },
    { name: "products_sku_key", columns: ["sku"], unique: true },
  ],
  triggers: [],
};

const ordersTable: TableDef = {
  name: "orders",
  kind: "table",
  schema: "public",
  rowCount: seedTableData.orders.rows.length,
  columns: [
    { name: "id", type: "integer", nullable: false, primaryKey: true },
    {
      name: "user_id",
      type: "integer",
      nullable: false,
      references: { table: "users", column: "id" },
    },
    { name: "status", type: "varchar", nullable: false, defaultValue: "'pending'" },
    { name: "total_cents", type: "integer", nullable: false },
    { name: "paid_at", type: "timestamp", nullable: true },
    { name: "created_at", type: "timestamp", nullable: false, defaultValue: "now()" },
  ],
  indexes: [
    { name: "orders_pkey", columns: ["id"], unique: true },
    { name: "orders_user_idx", columns: ["user_id"], unique: false },
    { name: "orders_status_idx", columns: ["status"], unique: false },
  ],
  triggers: [
    { name: "orders_audit", timing: "AFTER", event: "UPDATE" },
  ],
};

const orderItemsTable: TableDef = {
  name: "order_items",
  kind: "table",
  schema: "public",
  rowCount: seedTableData.order_items.rows.length,
  columns: [
    { name: "id", type: "integer", nullable: false, primaryKey: true },
    {
      name: "order_id",
      type: "integer",
      nullable: false,
      references: { table: "orders", column: "id" },
    },
    {
      name: "product_id",
      type: "integer",
      nullable: false,
      references: { table: "products", column: "id" },
    },
    { name: "quantity", type: "integer", nullable: false, defaultValue: "1" },
    { name: "unit_price_cents", type: "integer", nullable: false },
  ],
  indexes: [
    { name: "order_items_pkey", columns: ["id"], unique: true },
    { name: "order_items_order_idx", columns: ["order_id"], unique: false },
  ],
  triggers: [],
};

const customersTable: TableDef = {
  name: "customers",
  kind: "table",
  schema: "public",
  rowCount: seedTableData.customers.rows.length,
  columns: [
    { name: "id", type: "integer", nullable: false, primaryKey: true },
    { name: "company", type: "varchar", nullable: false },
    { name: "email", type: "varchar", nullable: false, unique: true },
    { name: "country_code", type: "varchar", nullable: true },
    { name: "terms", type: "varchar", nullable: true },
    { name: "created_at", type: "timestamp", nullable: false, defaultValue: "now()" },
  ],
  indexes: [
    { name: "customers_pkey", columns: ["id"], unique: true },
    { name: "customers_email_key", columns: ["email"], unique: true },
  ],
  triggers: [],
};

const invoicesTable: TableDef = {
  name: "invoices",
  kind: "table",
  schema: "public",
  rowCount: seedTableData.invoices.rows.length,
  columns: [
    { name: "id", type: "integer", nullable: false, primaryKey: true },
    { name: "reference", type: "varchar", nullable: false, unique: true },
    {
      name: "order_id",
      type: "integer",
      nullable: false,
      references: { table: "orders", column: "id" },
    },
    { name: "amount_cents", type: "integer", nullable: false },
    { name: "status", type: "varchar", nullable: false, defaultValue: "'draft'" },
    { name: "paid_at", type: "timestamp", nullable: true },
    { name: "issued_at", type: "timestamp", nullable: false, defaultValue: "now()" },
  ],
  indexes: [
    { name: "invoices_pkey", columns: ["id"], unique: true },
    { name: "invoices_order_idx", columns: ["order_id"], unique: false },
    { name: "invoices_status_idx", columns: ["status"], unique: false },
  ],
  triggers: [
    { name: "invoices_audit", timing: "AFTER", event: "UPDATE" },
  ],
};

const activeOrdersView: TableDef = {
  name: "active_orders",
  kind: "view",
  schema: "public",
  rowCount: 0,
  columns: [
    { name: "id", type: "integer", nullable: false },
    { name: "user_id", type: "integer", nullable: false },
    { name: "status", type: "varchar", nullable: false },
    { name: "total_cents", type: "integer", nullable: false },
  ],
  indexes: [],
  triggers: [],
};

const revenueByMonthMatView: TableDef = {
  name: "revenue_by_month",
  kind: "materialized_view",
  schema: "public",
  rowCount: 24,
  columns: [
    { name: "month", type: "date", nullable: false },
    { name: "orders_count", type: "integer", nullable: false },
    { name: "revenue_cents", type: "numeric", nullable: false },
  ],
  indexes: [],
  triggers: [],
};

export const seedSchema: SchemaTree = {
  database: "acme_prod",
  databases: ["acme_prod", "acme_staging", "postgres"],
  schemas: [
    {
      name: "public",
      tables: [
        customersTable,
        invoicesTable,
        ordersTable,
        orderItemsTable,
        productsTable,
        usersTable,
        categoriesTable,
        activeOrdersView,
        revenueByMonthMatView,
      ],
    },
  ],
};

// Anchored to the real clock so relative labels ("expire dans 3 min",
// "il y a 4 s") read live in the demo.
const now = new Date();
function ago(minutes: number) {
  return new Date(now.getTime() - minutes * 60000).toISOString();
}
function ahead(minutes: number) {
  return new Date(now.getTime() + minutes * 60000).toISOString();
}

export const seedQueue: QueueEntry[] = [
  {
    id: "q1",
    origin: "agent",
    originLabel: "claude-code",
    profileId: "p_acme_local",
    profileName: "locale",
    database: "acme_dev",
    environment: "local",
    sql: "UPDATE products SET price_cents = 5200 WHERE id = 5;",
    statementKind: "update",
    affectedRows: 1,
    affectedLabel: "1 ligne",
    risk: "low",
    targetObjects: ["public.products"],
    diffs: [{ column: "price_cents", oldValue: 5400, newValue: 5200 }],
    createdAt: ago(2),
    expiresAt: ahead(3),
    status: "pending",
  },
  {
    id: "q2",
    origin: "human-ui",
    originLabel: "Édition en ligne",
    profileId: "p_acme_local",
    profileName: "locale",
    database: "acme_dev",
    environment: "local",
    sql: "UPDATE users SET country_code = 'DE'\nWHERE id = 12\n  AND country_code IS NOT DISTINCT FROM 'FR';",
    statementKind: "update",
    affectedRows: 1,
    affectedLabel: "1 ligne",
    risk: "low",
    targetObjects: ["public.users"],
    diffs: [{ column: "country_code", oldValue: "FR", newValue: "DE" }],
    createdAt: ago(5),
    expiresAt: ahead(1),
    status: "pending",
  },
  {
    id: "q3",
    origin: "agent",
    originLabel: "codex",
    profileId: "p_acme_staging",
    profileName: "staging",
    database: "acme_staging",
    environment: "staging",
    sql: "DELETE FROM order_items WHERE order_id IN (\n  SELECT id FROM orders WHERE status = 'refunded'\n);",
    statementKind: "delete",
    affectedRows: null,
    affectedLabel: "nombre de lignes inconnu",
    risk: "high",
    targetObjects: ["public.order_items"],
    createdAt: ago(9),
    expiresAt: ahead(2),
    status: "pending",
  },
  {
    id: "q4",
    origin: "schema-editor",
    originLabel: "Éditeur de schéma",
    profileId: "p_acme_local",
    profileName: "locale",
    database: "acme_dev",
    environment: "local",
    sql: "ALTER TABLE products ADD COLUMN discount_pct numeric(4,2) DEFAULT 0;",
    statementKind: "ddl",
    affectedRows: null,
    affectedLabel: "DDL · modifie public.products",
    risk: "medium",
    targetObjects: ["public.products"],
    createdAt: ago(14),
    expiresAt: ahead(1),
    status: "pending",
  },
];

export const seedHistory: HistoryEntry[] = [
  {
    id: "h1",
    profileId: "p_acme_local",
    sql: "SELECT * FROM orders WHERE status = 'paid' ORDER BY created_at DESC;",
    source: "human",
    durationMs: 12,
    rowCount: 48,
    ranAt: ago(1),
    ok: true,
  },
  {
    id: "h2",
    profileId: "p_acme_local",
    sql: "SELECT count(*) FROM users WHERE is_verified = true;",
    source: "agent",
    agentClient: "claude-code",
    durationMs: 5,
    rowCount: 1,
    ranAt: ago(3),
    ok: true,
  },
  {
    id: "h3",
    profileId: "p_acme_local",
    sql: "SELECT p.name, sum(oi.quantity) AS sold\nFROM order_items oi\nJOIN products p ON p.id = oi.product_id\nGROUP BY p.name ORDER BY sold DESC LIMIT 10;",
    source: "human",
    durationMs: 31,
    rowCount: 10,
    ranAt: ago(22),
    ok: true,
  },
  {
    id: "h4",
    profileId: "p_acme_staging",
    sql: "SELECT * FROM information_schema.tables;",
    source: "agent",
    agentClient: "codex",
    durationMs: 44,
    rowCount: 63,
    ranAt: ago(48),
    ok: true,
  },
];

export const seedSaved: SavedQuery[] = [
  {
    id: "s1",
    name: "Top customers by revenue",
    profileId: "p_acme_local",
    sql: "SELECT u.full_name, sum(o.total_cents)/100.0 AS revenue\nFROM orders o\nJOIN users u ON u.id = o.user_id\nWHERE o.status IN ('paid','shipped','delivered')\nGROUP BY u.full_name\nORDER BY revenue DESC\nLIMIT 20;",
    updatedAt: ago(120),
  },
  {
    id: "s2",
    name: "Low stock products",
    profileId: "p_acme_local",
    sql: "SELECT name, stock FROM products WHERE stock < 20 ORDER BY stock ASC;",
    updatedAt: ago(300),
  },
  {
    id: "s3",
    name: "Refunds last 30 days",
    profileId: "p_acme_staging",
    sql: "SELECT * FROM orders WHERE status = 'refunded';",
    updatedAt: ago(1440),
  },
];

// Anchored to the real clock so "last activity" reads live (il y a 4 s / 12 min).
const realAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60000).toISOString();

export const seedMcpClients: McpClient[] = [
  {
    id: "m1",
    name: "claude-code",
    createdAt: ago(180),
    lastActivity: realAgo(0.07),
    revoked: false,
  },
  {
    id: "m2",
    name: "codex",
    createdAt: ago(60),
    lastActivity: realAgo(12),
    revoked: false,
  },
];

export const seedAudit: AuditEntry[] = [
  { id: "a1", client: "claude-code", profileName: "acme · staging", requestType: "SELECT · invoices", at: ago(2), outcome: "executed" },
  { id: "a2", client: "claude-code", profileName: "acme · staging", requestType: "UPDATE · orders (via file)", at: ago(6), outcome: "approved" },
  { id: "a3", client: "codex", profileName: "acme · production", requestType: "SELECT · users", at: ago(49), outcome: "rejected" },
  { id: "a4", client: "codex", profileName: "acme · staging", requestType: "DELETE · orders (via file)", at: ago(53), outcome: "rejected" },
];
