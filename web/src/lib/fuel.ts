// Fuel estimate shown in the app with its working:
//   litres = distance in km x vehicle L/100 km / 100 + idle allowance per stop x stops

export type FuelInputs = {
  distanceM: number;
  litresPer100Km: number;
  stops: number;
  idleLitresPerStop: number;
  pricePerLitre?: number | null;
};

export function estimateFuel({ distanceM, litresPer100Km, stops, idleLitresPerStop, pricePerLitre }: FuelInputs) {
  const km = distanceM / 1000;
  const driving = (km * litresPer100Km) / 100;
  const idle = stops * idleLitresPerStop;
  const litres = Math.round((driving + idle) * 100) / 100;
  const cost = pricePerLitre ? Math.round(litres * pricePerLitre * 100) / 100 : null;
  return { km: Math.round(km * 10) / 10, driving: Math.round(driving * 100) / 100, idle: Math.round(idle * 100) / 100, litres, cost };
}

export function fuelFormula(i: FuelInputs): string {
  const r = estimateFuel(i);
  return `${r.km} km x ${i.litresPer100Km} L/100 km / 100 = ${r.driving} L, plus ${i.stops} stops x ${i.idleLitresPerStop} L idle = ${r.idle} L`;
}
