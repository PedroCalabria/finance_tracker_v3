import { monthOf, todayIn, type ISODate, type Month } from '@ff/shared';

/** Hoje e o mês atual no fuso da pessoa: toda regra de "atrasado" depende disso. */
export interface Clock {
  today: ISODate;
  currentMonth: Month;
}

export function clockAt(timeZone: string, now: Date): Clock {
  const today = todayIn(timeZone, now);
  return { today, currentMonth: monthOf(today) };
}
