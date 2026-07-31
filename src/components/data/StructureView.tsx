import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Link2, Hash, Zap, Code2, Plus, Pencil } from "lucide-react";
import { activeProfile, useStore, type TableSubView } from "@/store";
import { allTables } from "@/lib/backend";
import { typeColor } from "@/components/shared";
import { ViewTabs } from "@/components/workspace/ViewTabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function StructureView({
  tableName,
  subView,
  onSub,
}: {
  tableName: string;
  subView?: TableSubView;
  onSub?: (v: TableSubView) => void;
}) {
  const { t } = useTranslation();
  const profile = useStore(activeProfile);
  const enqueue = useStore((s) => s.enqueue);
  const schema = useStore((s) => s.schema);
  const table = allTables(schema).find((x) => x.name === tableName);
  const [tab, setTab] = useState<"columns" | "indexes" | "triggers" | "ddl">(
    "columns"
  );
  if (!table) return null;

  function generatedDdl() {
    if (!table) return "";
    const colLines = table.columns.map((c) => {
      let line = `  ${c.name} ${c.type}${c.type === "varchar" ? "(255)" : ""}`;
      if (!c.nullable) line += " NOT NULL";
      if (c.defaultValue) line += ` DEFAULT ${c.defaultValue}`;
      return line;
    });
    const pk = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
    if (pk.length) colLines.push(`  PRIMARY KEY (${pk.join(", ")})`);
    for (const c of table.columns) {
      if (c.references)
        colLines.push(
          `  FOREIGN KEY (${c.name}) REFERENCES ${c.references.table}(${c.references.column})`
        );
    }
    return `CREATE TABLE ${table.schema}.${table.name} (\n${colLines.join(
      ",\n"
    )}\n);`;
  }

  function addColumnDdl() {
    if (!profile || !table) return;
    const sql = `ALTER TABLE ${table.name} ADD COLUMN new_column varchar(255);`;
    void enqueue({
      origin: "schema-editor",
      originLabel: t("structure.schemaEditor"),
      profileId: profile.id,
      profileName: profile.name,
      database: profile.database,
      environment: profile.environment,
      sql,
      statementKind: "ddl",
      affectedRows: null,
      affectedLabel: t("structure.altersLabel", { table: `${table.schema}.${table.name}` }),
      risk: "medium",
      targetObjects: [`${table.schema}.${table.name}`],
    });
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      {subView && onSub && (
        <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
          <ViewTabs value={subView} onChange={onSub} />
        </div>
      )}
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <SubTab active={tab === "columns"} onClick={() => setTab("columns")} icon={<Hash className="h-3.5 w-3.5" />}>
          {t("structure.columns", { n: table.columns.length })}
        </SubTab>
        <SubTab active={tab === "indexes"} onClick={() => setTab("indexes")} icon={<Hash className="h-3.5 w-3.5" />}>
          {t("structure.indexes", { n: table.indexes.length })}
        </SubTab>
        <SubTab active={tab === "triggers"} onClick={() => setTab("triggers")} icon={<Zap className="h-3.5 w-3.5" />}>
          {t("structure.triggers", { n: table.triggers.length })}
        </SubTab>
        <SubTab active={tab === "ddl"} onClick={() => setTab("ddl")} icon={<Code2 className="h-3.5 w-3.5" />}>
          {t("structure.ddl")}
        </SubTab>
        <div className="flex-1" />
        {!profile?.readOnly && (
          <Button variant="outline" size="xs" onClick={addColumnDdl}>
            <Plus className="h-3.5 w-3.5" /> {t("structure.addColumn")}
          </Button>
        )}
      </div>

      <div className="p-4">
        {tab === "columns" && (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-border bg-panel-2 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">{t("structure.colColumn")}</th>
                  <th className="px-3 py-2 font-medium">{t("structure.colType")}</th>
                  <th className="px-3 py-2 font-medium">{t("structure.colNullable")}</th>
                  <th className="px-3 py-2 font-medium">{t("structure.colDefault")}</th>
                  <th className="px-3 py-2 font-medium">{t("structure.colKey")}</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {table.columns.map((c) => (
                  <tr key={c.name} className="border-b border-border/50 last:border-0 hover:bg-panel-2/40">
                    <td className="px-3 py-2 font-medium text-foreground">{c.name}</td>
                    <td className="px-3 py-2">
                      <span style={{ color: typeColor(c.type) }} className="font-mono">
                        {c.type}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {c.nullable ? t("structure.nullableYes") : t("structure.nullableNo")}
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">
                      {c.defaultValue ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        {c.primaryKey && (
                          <Badge variant="warning">
                            <KeyRound className="h-3 w-3" /> PK
                          </Badge>
                        )}
                        {c.unique && !c.primaryKey && <Badge variant="info">unique</Badge>}
                        {c.references && (
                          <Badge variant="default">
                            <Link2 className="h-3 w-3" /> {c.references.table}.{c.references.column}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-2">
                      {!profile?.readOnly && (
                        <Pencil className="h-3 w-3 text-muted-foreground/50" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "indexes" && (
          <div className="space-y-2">
            {table.indexes.map((idx) => (
              <div key={idx.name} className="flex items-center gap-3 rounded-lg border border-border bg-panel-2 px-3 py-2">
                <Hash className="h-4 w-4 text-info" />
                <span className="font-mono text-[12.5px] text-foreground">{idx.name}</span>
                <span className="text-[12px] text-muted-foreground">({idx.columns.join(", ")})</span>
                {idx.unique && <Badge variant="info">unique</Badge>}
              </div>
            ))}
          </div>
        )}

        {tab === "triggers" && (
          <div className="space-y-2">
            {table.triggers.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t("structure.noTriggers")}</p>
            ) : (
              table.triggers.map((tr) => (
                <div key={tr.name} className="flex items-center gap-3 rounded-lg border border-border bg-panel-2 px-3 py-2">
                  <Zap className="h-4 w-4 text-warning" />
                  <span className="font-mono text-[12.5px] text-foreground">{tr.name}</span>
                  <Badge variant="outline">{tr.timing} {tr.event}</Badge>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "ddl" && (
          <pre className="overflow-auto rounded-lg border border-border bg-input-bg p-4 font-mono text-[12.5px] leading-relaxed text-foreground/90">
            {generatedDdl()}
          </pre>
        )}
      </div>
    </div>
  );
}

function SubTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] transition-colors " +
        (active
          ? "bg-panel-2 font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      {icon}
      {children}
    </button>
  );
}
