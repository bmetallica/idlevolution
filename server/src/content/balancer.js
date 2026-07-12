// Balancing-Schutz für KI-generierte Packs. Grenzen kommen aus data/balance.config.json.
// Strategie: Werte werden wo möglich auf die Grenze gekappt (Clamping, mit Notiz);
// harte Verstöße (Produktion aus dem Nichts, Epochen-Sprünge) führen zur Ablehnung des Items.

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function valueOf(map, lookupValue) {
  return Object.entries(map || {}).reduce((sum, [rid, amount]) => sum + amount * lookupValue(rid), 0);
}

/**
 * @param {object} pack - strukturell und referenziell validiertes Pack
 * @param {object} registry - aktuelle Registry
 * @param {object} balance - balance-Sektion aus balance.config.json
 * @returns {{pack: object, rejected: Array<{type,id,reason}>, notes: string[]}}
 */
export function balancePack(pack, registry, balance) {
  const rejected = [];
  const notes = [];
  const out = structuredClone(pack);

  // Mengenlimits pro Pack
  const limit = (arr, max, type) => {
    if (!arr || arr.length <= max) return arr;
    for (const item of arr.slice(max)) rejected.push({ type, id: item.id, reason: `Limit: max. ${max} neue ${type} pro Pack` });
    return arr.slice(0, max);
  };
  out.resources = limit(out.resources, balance.maxNewResourcesPerPack ?? 3, 'resource');
  out.buildings = limit(out.buildings, balance.maxNewBuildingsPerPack ?? 4, 'building');
  out.epochs = limit(out.epochs, balance.maxNewEpochsPerPack ?? 1, 'epoch');

  // ── Ressourcen: baseValue in erlaubten Bereich kappen ──
  const [minVal, maxVal] = balance.resourceBaseValueRange ?? [0.1, 1000];
  for (const r of out.resources || []) {
    const clamped = clamp(r.baseValue, minVal, maxVal);
    if (clamped !== r.baseValue) {
      notes.push(`Ressource '${r.id}': baseValue ${r.baseValue} → ${clamped} gekappt`);
      r.baseValue = clamped;
    }
  }

  // Wert-Lookup über Registry + neue Ressourcen dieses Packs
  const packResources = new Map((out.resources || []).map((r) => [r.id, r]));
  const lookupValue = (rid) => packResources.get(rid)?.baseValue ?? registry.resources.get(rid)?.baseValue ?? 1;
  const packEpochs = new Map((out.epochs || []).map((e) => [e.id, e]));
  const epochOrderOf = (eid) => packEpochs.get(eid)?.order ?? registry.epochs.get(eid)?.order ?? 0;

  // ── Epochen: order muss lückenlos anschließen ──
  const maxOrder = Math.max(-1, ...[...registry.epochs.values()].map((e) => e.order));
  out.epochs = (out.epochs || []).filter((e) => {
    if (e.order !== maxOrder + 1) {
      rejected.push({ type: 'epoch', id: e.id, reason: `order muss ${maxOrder + 1} sein (war ${e.order})` });
      packEpochs.delete(e.id);
      return false;
    }
    if (e.modifiers?.productionMultiplier !== undefined) {
      const prev = [...registry.epochs.values()].find((p) => p.order === e.order - 1);
      const prevMult = prev?.modifiers?.productionMultiplier ?? 1;
      const cap = prevMult * (1 + (balance.maxIncreaseOverBest ?? 0.25));
      if (e.modifiers.productionMultiplier > cap) {
        notes.push(`Epoche '${e.id}': productionMultiplier ${e.modifiers.productionMultiplier} → ${cap.toFixed(2)} gekappt`);
        e.modifiers.productionMultiplier = cap;
      }
    }
    return true;
  });

  // Bester existierender Netto-Wert pro Tick je Epochen-Order (für die Relativ-Grenze)
  const bestNetByOrder = new Map();
  for (const b of registry.buildings.values()) {
    if (!b.production) continue;
    const net =
      valueOf(b.production.outputs, lookupValue) - valueOf(b.production.inputs, lookupValue);
    const order = epochOrderOf(b.epoch);
    if (net > (bestNetByOrder.get(order) ?? 0)) bestNetByOrder.set(order, net);
  }

  // ── Gebäude ──
  const rejectedResourceIds = new Set(rejected.filter((r) => r.type === 'resource').map((r) => r.id));
  const rejectedEpochIds = new Set(rejected.filter((r) => r.type === 'epoch').map((r) => r.id));
  const stillExists = (rid) =>
    rid === '*' || registry.resources.has(rid) || (packResources.has(rid) && !rejectedResourceIds.has(rid));

  out.buildings = (out.buildings || []).filter((b) => {
    // Abhängigkeits-Propagation: referenziert das Gebäude ein abgelehntes Item?
    const referenced = [
      ...Object.keys(b.cost || {}),
      ...Object.keys(b.production?.inputs || {}),
      ...Object.keys(b.production?.outputs || {}),
      ...Object.keys(b.storage || {}),
      ...Object.keys(b.requires?.resources || {}),
    ];
    if (referenced.some((rid) => !stillExists(rid)) || rejectedEpochIds.has(b.epoch)) {
      rejected.push({ type: 'building', id: b.id, reason: 'referenziert ein abgelehntes Item' });
      return false;
    }

    // Basiskappungen
    const bt = clamp(b.buildTimeTicks ?? 1, 1, balance.maxBuildTimeTicks ?? 500);
    if (bt !== (b.buildTimeTicks ?? 1)) notes.push(`Gebäude '${b.id}': buildTimeTicks → ${bt}`);
    b.buildTimeTicks = bt;
    const w = clamp(b.workers ?? 0, 0, balance.maxWorkers ?? 20);
    if (w !== (b.workers ?? 0)) notes.push(`Gebäude '${b.id}': workers → ${w}`);
    b.workers = w;
    if (b.housing?.capacity) {
      const c = clamp(b.housing.capacity, 1, balance.maxHousingCapacity ?? 100);
      if (c !== b.housing.capacity) notes.push(`Gebäude '${b.id}': housing.capacity → ${c}`);
      b.housing.capacity = c;
    }
    for (const [rid, v] of Object.entries(b.storage || {})) {
      const c = clamp(v, 1, balance.maxStoragePerResource ?? 100000);
      if (c !== v) notes.push(`Gebäude '${b.id}': storage.${rid} → ${c}`);
      b.storage[rid] = c;
    }
    // Wehranlagen (Kriegssystem): defense an die Epoche koppeln, damit die KI
    // keine übermächtige Festung in die Steinzeit stellt.
    if (b.meta?.military?.defense != null) {
      const maxDef = (balance.maxDefensePerEpochOrder ?? 15) * (epochOrderOf(b.epoch) + 1);
      const d = clamp(Math.round(b.meta.military.defense) || 1, 1, maxDef);
      if (d !== b.meta.military.defense) notes.push(`Gebäude '${b.id}': military.defense → ${d}`);
      b.meta.military.defense = d;
    }

    const costValue = valueOf(b.cost, lookupValue);
    if (costValue <= 0) {
      rejected.push({ type: 'building', id: b.id, reason: 'Baukosten müssen > 0 sein' });
      return false;
    }

    if (b.production && Object.keys(b.production.outputs || {}).length > 0) {
      const order = epochOrderOf(b.epoch);
      const inValue = valueOf(b.production.inputs, lookupValue);
      let outValue = valueOf(b.production.outputs, lookupValue);
      let net = outValue - inValue;

      // Kein Perpetuum mobile: Wertschöpfung ohne Arbeiter ist verboten
      if (b.workers === 0 && net > 0) {
        rejected.push({ type: 'building', id: b.id, reason: 'Produktion mit Wertschöpfung ohne Arbeiter' });
        return false;
      }

      // Absolutgrenze: Netto-Wert pro Tick ≤ Arbeiter × Wert/Arbeiter × Slack × Epochen-Wachstum
      const growth = Math.pow(balance.epochValueGrowth ?? 2, order);
      const absCap = b.workers * (balance.workerValuePerTick ?? 0.3) * (balance.netValueSlack ?? 1.5) * growth;
      // Relativgrenze: nicht mehr als X% über dem besten existierenden Produzenten der Epoche
      const best = bestNetByOrder.get(order);
      const relCap = best !== undefined && best > 0 ? best * (1 + (balance.maxIncreaseOverBest ?? 0.25)) : Infinity;
      const cap = Math.min(absCap, relCap);

      if (net > cap && outValue > 0) {
        const scale = (cap + inValue) / outValue;
        for (const rid of Object.keys(b.production.outputs)) {
          b.production.outputs[rid] = Math.round(b.production.outputs[rid] * scale * 1000) / 1000;
        }
        notes.push(`Gebäude '${b.id}': Outputs auf Balancing-Grenze skaliert (Netto ${net.toFixed(2)} → ${cap.toFixed(2)})`);
        outValue = valueOf(b.production.outputs, lookupValue);
        net = outValue - inValue;
      }

      // Amortisation: Baukosten dürfen sich nicht zu schnell rentieren
      const minAmort = balance.minAmortizationTicks ?? 60;
      if (net > 0 && costValue / net < minAmort) {
        const factor = (minAmort * net) / costValue;
        for (const rid of Object.keys(b.cost)) {
          b.cost[rid] = Math.ceil(b.cost[rid] * factor);
        }
        notes.push(`Gebäude '${b.id}': Baukosten ×${factor.toFixed(2)} erhöht (Amortisation ≥ ${minAmort} Ticks)`);
      }
    }
    return true;
  });

  // Abhängigkeits-Propagation für requires.buildings und advance-Bedingungen
  const rejectedBuildingIds = new Set(rejected.filter((r) => r.type === 'building').map((r) => r.id));
  const buildingStillExists = (bid) => registry.buildings.has(bid) || out.buildings.some((b) => b.id === bid);
  out.buildings = out.buildings.filter((b) => {
    const deps = Object.keys(b.requires?.buildings || {});
    if (deps.some((bid) => rejectedBuildingIds.has(bid) || !buildingStillExists(bid))) {
      rejected.push({ type: 'building', id: b.id, reason: 'Voraussetzung wurde abgelehnt' });
      return false;
    }
    return true;
  });
  out.epochs = (out.epochs || []).filter((e) => {
    const advRefs = [
      ...Object.keys(e.advance?.resources || {}).filter((rid) => !stillExists(rid)),
      ...Object.keys(e.advance?.buildings || {}).filter((bid) => !buildingStillExists(bid)),
    ];
    if (advRefs.length > 0) {
      rejected.push({ type: 'epoch', id: e.id, reason: `advance referenziert abgelehnte Items: ${advRefs.join(', ')}` });
      return false;
    }
    return true;
  });
  for (const [eid, adv] of Object.entries(out.epochAdvance || {})) {
    const bad =
      Object.keys(adv.resources || {}).some((rid) => !stillExists(rid)) ||
      Object.keys(adv.buildings || {}).some((bid) => !buildingStillExists(bid));
    if (bad) {
      rejected.push({ type: 'epochAdvance', id: eid, reason: 'referenziert abgelehnte Items' });
      delete out.epochAdvance[eid];
    }
  }
  // Neue Epoche ohne (nachgelieferte) Aufstiegsbedingung des Vorgängers ist unerreichbar
  out.epochs = out.epochs.filter((e) => {
    const prev = [...registry.epochs.values()].find((p) => p.order === e.order - 1);
    if (prev && prev.advance == null && !(out.epochAdvance || {})[prev.id]) {
      rejected.push({ type: 'epoch', id: e.id, reason: `unerreichbar: epochAdvance für '${prev.id}' fehlt/abgelehnt` });
      return false;
    }
    return true;
  });

  return { pack: out, rejected, notes };
}
