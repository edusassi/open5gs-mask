// Seed three demo SIMs compatible with configs/open5gs-ue-*.yaml
// Usage: mongosh open5gs /path/to/seed-demo-sims.js

const KEY = "465B5CE8B199B49FAA5F0A2EE238A6BC";
const OPC = "E8ED289DEBA952E4283B54E88E6183CA";
const IMSIS = ["999700000000001", "999700000000002", "999700000000003"];

function doc(imsi) {
  return {
    schema_version: 1,
    imsi,
    msisdn: [],
    imeisv: [],
    mme_host: [],
    mm_realm: [],
    purge_flag: [],
    slice: [{
      sst: 1,
      default_indicator: true,
      session: [{
        name: "internet",
        type: 1,
        qos: {
          index: 9,
          arp: {
            priority_level: 8,
            pre_emption_capability: 1,
            pre_emption_vulnerability: 2
          }
        },
        ambr: {
          downlink: { value: 1000000000, unit: 0 },
          uplink: { value: 1000000000, unit: 0 }
        },
        pcc_rule: []
      }]
    }],
    security: { k: KEY, op: null, opc: OPC, amf: "8000" },
    ambr: {
      downlink: { value: 1000000000, unit: 0 },
      uplink: { value: 1000000000, unit: 0 }
    },
    access_restriction_data: 32,
    network_access_mode: 0,
    subscriber_status: 0,
    operator_determined_barring: 0,
    subscribed_rau_tau_timer: 12,
    __v: 0
  };
}

let added = 0;
for (const imsi of IMSIS) {
  if (db.subscribers.countDocuments({ imsi }) > 0) {
    print("exists " + imsi);
    continue;
  }
  db.subscribers.insertOne(doc(imsi));
  print("inserted " + imsi);
  added++;
}
print("total=" + db.subscribers.countDocuments({}));
print("added=" + added);
