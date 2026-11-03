// A small CSV/TSV reader for previews: quoted fields, escaped quotes, CRLF, and a row cap.

export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Data rows in the file, before the cap. */
  readonly totalRows: number;
  readonly truncated: boolean;
}

export function parseCsv(text: string, delimiter: "," | "\t", maxRows: number): CsvTable {
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

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
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
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRecord();
    } else {
      field += char;
      sawContent = true;
    }
  }
  if (sawContent || field !== "" || record.length > 0) endRecord();

  const [header = [], ...data] = records;
  return {
    header,
    rows: data.slice(0, maxRows),
    totalRows: data.length,
    truncated: data.length > maxRows,
  };
}
