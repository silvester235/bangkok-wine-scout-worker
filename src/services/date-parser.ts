const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,

  มกราคม: 1,
  กุมภาพันธ์: 2,
  มีนาคม: 3,
  เมษายน: 4,
  พฤษภาคม: 5,
  มิถุนายน: 6,
  กรกฎาคม: 7,
  สิงหาคม: 8,
  กันยายน: 9,
  ตุลาคม: 10,
  พฤศจิกายน: 11,
  ธันวาคม: 12,
};

function normalizeYear(year: number): number {
  if (year >= 2500) return year - 543;
  if (year < 100) return 2000 + year;
  return year;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function iso(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));

  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseEventDate(value: string | null): string | null {
  if (!value) return null;

  const text = value.trim();

  //
  // ISO
  //

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoMatch) {
    return iso(
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
    );
  }

  //
  // DD/MM/YYYY
  // DD-MM-YYYY
  // DD.MM.YYYY
  //

  const numeric = text.match(
    /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/,
  );

  if (numeric) {
    return iso(
      normalizeYear(Number(numeric[3])),
      Number(numeric[2]),
      Number(numeric[1]),
    );
  }

  //
  // 31 Jul 2026
  // 31 July
  // 31 กรกฎาคม 2569
  //

  const words = text.match(
    /^(\d{1,2})\s+([^\s]+)(?:\s+(\d{2,4}))?$/i,
  );

  if (words) {
    const day = Number(words[1]);

    const month = MONTHS[words[2].toLowerCase()];

    if (!month) return null;

    let year = words[3]
      ? normalizeYear(Number(words[3]))
      : new Date().getUTCFullYear();

    let result = iso(year, month, day);

    if (!result) return null;

    if (!words[3]) {
      const today = new Date().toISOString().slice(0, 10);

      if (result < today) {
        result = iso(year + 1, month, day);
      }
    }

    return result;
  }

  return null;
}