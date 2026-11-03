// A small CSV/TSV reader for previews: quoted fields, escaped quotes, CRLF, and a row cap.

export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Data rows in the file, before the cap. */
  readonly totalRows: number;
  readonly truncated: boolean;
  /** Width of the widest record, before the column cap. */
  readonly totalColumns: number;
  readonly columnsTruncated: boolean;
}

export function parseCsv(
  text: string,
  delimiter: "," | "\t",
  maxRows: number,
  maxColumns: number,
): CsvTable {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let sawContent = false;

  const endRecord = () => {
    record.push(field);
    if (record.length > 1 || record[0] !== "") records.push(record);
    record = [];
    field = "";
    sawContent = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === "") {
      quoted = true;
      sawContent = true;
    } else if (char === delimiter) {
      record.push(field);
      field = "";
      sawContent = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      endRecord();
    } else {
      field += char;
      sawContent = true;
    }
  }
  if (sawContent || field !== "" || record.length > 0) endRecord();

  const [header = [], ...data] = records;
  const totalColumns = records.reduce((widest, row) => Math.max(widest, row.length), 0);
  return {
    header: header.slice(0, maxColumns),
    rows: data.slice(0, maxRows).map((row) => row.slice(0, maxColumns)),
    totalRows: data.length,
    truncated: data.length > maxRows,
    totalColumns,
    columnsTruncated: totalColumns > maxColumns,
  };
}
