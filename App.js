import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { initializeApp, getApps } from "firebase/app";
import { getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc, getDocs } from "firebase/firestore";

// ─── Firebase Init ─────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAlytVP5K4GItgurjUt41_xH4BvEHYghJI",
  authDomain: "rrte-f0ccd.firebaseapp.com",
  projectId: "rrte-f0ccd",
  storageBucket: "rrte-f0ccd.firebasestorage.app",
  messagingSenderId: "1047700574007",
  appId: "1:1047700574007:web:6df68da9c17e29cdfbd4b2",
};
const fbApp = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

// ─── Constants ────────────────────────────────────────────────────────────────
const COST_CATEGORIES = ["Trucking", "Service & Repair", "Parts", "Cleaning", "Inspection", "Storage", "Other"];
const DOC_FOLDERS = ["Expense Receipts", "Purchase Receipt", "Tax Exemption Form"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const STATUS_COLORS = {
  Active:    { bg: "#1a3a2a", text: "#4ade80", border: "#166534" },
  Sold:      { bg: "#3a1a1a", text: "#f87171", border: "#7f1d1d" },
  "Trade-In":{ bg: "#2a2a1a", text: "#facc15", border: "#8a7010" },
};

const fmt = (n) => n == null || n === "" ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n) => n == null || n === "" ? "—" : Number(n).toLocaleString();

function generatePO(existing) {
  const year = new Date().getFullYear().toString().slice(-2);
  const nums = existing.map((e) => parseInt(e.poNumber?.replace(/[^0-9]/g,"") || "0")).filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1597;
  return `PO-${year}-${String(next).padStart(4,"0")}`;
}

function getTotals(e) {
  // Exclude any legacy isTradeAllowance costs — trade allowance is now stored separately
  const costs = (e.costs || []).filter(c => !c.isTradeAllowance);
  const totalCosts = costs.reduce((s, c) => s + c.amount, 0);
  const totalIn = e.purchasePrice + totalCosts;
  // Trade allowance reduces money owed but does NOT affect cost basis or margin
  const tradeAllowance = e.tradeAllowance || 0;
  const cashDue = e.salePrice != null ? e.salePrice - tradeAllowance : null;
  // Margin = sale price minus cost in (trade allowance doesn't affect this)
  const margin = e.salePrice != null ? e.salePrice - totalIn : null;
  const marginPct = margin != null && e.salePrice > 0 ? (margin / e.salePrice) * 100 : null;
  return { totalCosts, totalIn, margin, marginPct, tradeAllowance, cashDue };
}

// ─── AI Receipt Scanner ───────────────────────────────────────────────────────
async function scanReceiptWithAI(base64Data, mimeType) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimeType, data: base64Data }
            },
            {
              type: "text",
              text: `You are analyzing a receipt or invoice image for an equipment dealer's expense tracking system.

Extract the following and respond ONLY with a valid JSON object, no markdown, no explanation:
{
  "vendor": "vendor/business name or empty string",
  "total": number (the final total dollar amount as a number, e.g. 245.50),
  "date": "YYYY-MM-DD format if found, else empty string",
  "description": "brief 1-line description of what was purchased/serviced",
  "category": "one of: Trucking, Service & Repair, Parts, Cleaning, Inspection, Storage, Other",
  "confidence": "high | medium | low"
}

If you cannot find a clear total amount, set total to 0. Be conservative — only extract what is clearly visible.`
            }
          ]
        }]
      })
    });
    const data = await res.json();
    const text = data.content?.map(b => b.text || "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("AI scan error:", err);
    return null;
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  app:        { minHeight: "100vh", background: "#1c1f2e", color: "#dde4f0", fontFamily: "'Inter', system-ui, sans-serif", fontSize: 14 },
  header:     { background: "#12151f", borderBottom: "2px solid #c9a227", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 58, position: "sticky", top: 0, zIndex: 50 },
  logoWrap:   { display: "flex", alignItems: "center", gap: 10 },
  logoIcon:   { width: 36, height: 36, background: "#c9a227", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 },
  logoText:   { fontSize: 18, fontWeight: 700, letterSpacing: "0.04em", color: "#edf2fc" },
  logoSub:    { fontSize: 11, color: "#7a8aaa", letterSpacing: "0.1em", textTransform: "uppercase" },
  nav:        { display: "flex", gap: 4, flexWrap: "wrap" },
  navBtn:     (a) => ({ background: a ? "#c9a227" : "transparent", color: a ? "#fff" : "#8a9aba", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 500 }),
  main:       { padding: 24, maxWidth: 1200, margin: "0 auto" },
  card:       { background: "#1e2235", border: "1px solid #2a3055", borderRadius: 10, padding: 20, marginBottom: 16 },
  statGrid:   { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 24 },
  statCard:   (c) => ({ background: "#1e2235", border: `1px solid ${c}33`, borderRadius: 10, padding: "16px 20px", borderLeft: `3px solid ${c}` }),
  statVal:    (c) => ({ fontSize: 26, fontWeight: 800, color: c, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }),
  statLbl:    { fontSize: 11, color: "#7a8aaa", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 2 },
  poTag:      { fontFamily: "monospace", fontSize: 12, background: "#12151f", border: "1px solid #b4530960", color: "#d4a817", padding: "2px 8px", borderRadius: 4, letterSpacing: "0.08em" },
  badge:      (s) => ({ display: "inline-block", padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", background: STATUS_COLORS[s]?.bg || "#333", color: STATUS_COLORS[s]?.text || "#aaa", border: `1px solid ${STATUS_COLORS[s]?.border || "#555"}` }),
  btn:        (v="primary") => ({ background: v==="primary"?"#c9a227":v==="success"?"#166534":v==="danger"?"#7f1d1d":v==="ghost"?"transparent":"#252c48", color: v==="ghost"?"#8a9aba":"#fff", border: v==="ghost"?"1px solid #2e3a58":"none", borderRadius: 7, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600, touchAction:"manipulation", WebkitTapHighlightColor:"transparent" }),
  input:      { background: "#12151f", border: "1px solid #3a4470", borderRadius: 7, color: "#dde4f0", padding: "8px 12px", fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none" },
  label:      { fontSize: 11, color: "#7a8aaa", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4, display: "block" },
  grid2:      { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  grid3:      { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 },
  divider:    { border: "none", borderTop: "1px dashed #2d4060", margin: "16px 0" },
  secTitle:   { fontSize: 11, color: "#c9a227", textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: 12 },
  modal:      { position: "fixed", inset: 0, background: "#000b", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 },
  modalCard:  { background: "#1e2235", border: "1px solid #b45309", borderRadius: 12, padding: 28, width: "100%", maxWidth: 560, maxHeight: "88vh", overflowY: "auto" },
};

// ─── Sub-components ───────────────────────────────────────────────────────────
const Field = ({ label, value, onChange, type="text", placeholder="" }) => (
  <div>
    <label style={S.label}>{label}</label>
    <input style={S.input} type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
  </div>
);
const Select = ({ label, value, onChange, options }) => (
  <div>
    <label style={S.label}>{label}</label>
    <select style={{...S.input, appearance:"none"}} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  </div>
);

// Toggle switch
const Toggle = ({ checked, onChange, label, color="#4ade80" }) => (
  <label style={{ display:"flex", alignItems:"center", gap:10, cursor:"pointer", userSelect:"none" }}>
    <div style={{ position:"relative", width:44, height:24 }} onClick={() => onChange(!checked)}>
      <div style={{ position:"absolute", inset:0, borderRadius:12, background: checked ? color+"44" : "#252c48", border:`1px solid ${checked?color:"#30405a"}`, transition:"all 0.2s" }} />
      <div style={{ position:"absolute", top:3, left: checked ? 22 : 3, width:16, height:16, borderRadius:8, background: checked ? color : "#3a4a2a", transition:"all 0.2s" }} />
    </div>
    {label && <span style={{ fontSize:13, color: checked ? color : "#7a8aaa", fontWeight:600 }}>{label}</span>}
  </label>
);

// Folder tab component
const FolderTab = ({ active, label, count, onClick }) => (
  <button onClick={onClick} style={{ background: active ? "#1e2436" : "#111520", border: `1px solid ${active?"#c9a227":"#252c48"}`, borderBottom: active ? "1px solid #162230" : "1px solid #2a3055", borderRadius: "6px 6px 0 0", padding: "8px 16px", cursor:"pointer", color: active ? "#d4a817" : "#7a8aaa", fontSize:12, fontWeight:600, display:"flex", alignItems:"center", gap:6, marginBottom:"-1px", position:"relative", zIndex: active?2:1 }}>
    📁 {label}
    {count > 0 && <span style={{ background:"#c9a227", color:"#fff", borderRadius:10, padding:"1px 6px", fontSize:10 }}>{count}</span>}
  </button>
);

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [equipment, setEquipment] = useState([]);
  const [logisticsReady, setLogisticsReady] = useState(false);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [view, setView] = useState("dashboard");
  const [selectedId, setSelectedId] = useState(null);
  const [showAddCost, setShowAddCost] = useState(false);
  const [showSell, setShowSell] = useState(false);
  const [showTradeIn, setShowTradeIn] = useState(false);
  const [showReceiptModal, setShowReceiptModal] = useState(null); // folder name
  const [showDocViewer, setShowDocViewer] = useState(null); // { src, name }
  const [filterStatus, setFilterStatus] = useState("All");
  const [searchQ, setSearchQ] = useState("");
  const [activeFolder, setActiveFolder] = useState(DOC_FOLDERS[0]);
  const [reportMonth, setReportMonth] = useState(() => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; });
  const [scanResult, setScanResult] = useState(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [pendingUpload, setPendingUpload] = useState(null); // { base64, mimeType, name, folder }
  const [manualAmount, setManualAmount] = useState(""); // override for AI-extracted amount
  const fileInputRef = useRef();

  const [newEquip, setNE] = useState({ make:"", model:"", year:"", serialNumber:"", hours:"", purchasePrice:"", purchaseFrom:"", checkNumber:"", equipType:"Farm", notes:"", isTradeIn:false, tradeOnPoNumber:"", tradeAllowance:"" });
  const [newCost, setNC] = useState({ category:"Trucking", description:"", amount:"", date:new Date().toISOString().slice(0,10) });
  const [sellInfo, setSI] = useState({ salePrice:"", soldTo:"", saleDate:new Date().toISOString().slice(0,10) });
  const [tradeInfo, setTI] = useState({ make:"", model:"", year:"", serialNumber:"", hours:"", tradeAllowance:"", equipType:"Farm", notes:"" });

  // ── Logistics state ──
  const [logisticsItems, setLogisticsItems] = useState([]);
  const syncRef = useRef(false);
  const [showAddLogistics, setShowAddLogistics] = useState(false);
  const [newLogItem, setNLI] = useState({ make:"", model:"", year:"", serialNumber:"", hours:"", price:"", dealerName:"", location:"", equipType:"Farm", notes:"" });
  const [editLogId, setEditLogId] = useState(null);
  const [editLogData, setEditLogData] = useState({});
  const [localPrices, setLP] = useState({});
  const [invoiceSelectedId, setInvoiceSelectedId] = useState("");
  const [appUnlocked, setAppUnlocked] = useState(false);
  const [appPinInput, setAppPinInput] = useState("");
  const [appPinError, setAppPinError] = useState(false);
  const [appPinShake, setAppPinShake] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPinInput, setAdminPinInput] = useState("");
  const [adminPinError, setAdminPinError] = useState(false);
  const [adminEditId, setAdminEditId] = useState(null);
  const [adminEditData, setAdminEditData] = useState({});
  const [invoiceTax, setInvoiceTax] = useState("");
  const [invoiceFreight, setInvoiceFreight] = useState("");
  const [editingPO, setEditingPO] = useState(false);
  const [editingPOValue, setEditingPOValue] = useState("");

  const selected = equipment.find(e => e.id === selectedId);

  // ── Firebase Firestore — real-time listeners ──
  useEffect(() => {
    // Listen to equipment collection — updates instantly for all users
    const unsubEq = onSnapshot(
      collection(db, "equipment"),
      (snap) => {
        const items = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        setEquipment(items);
        syncRef.current = true;
        setStorageLoaded(true);
      },
      (err) => { console.error("Equipment listener error:", err); setStorageLoaded(true); }
    );
    // Listen to logistics collection
    const unsubLg = onSnapshot(
      collection(db, "logistics"),
      (snap) => {
        const items = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        setLogisticsItems(items);
      },
      (err) => { console.error("Logistics listener error:", err); }
    );
    return () => { unsubEq(); unsubLg(); };
  }, []);

  // ── Helpers ──
  // ── Firestore helpers ──
  // updEq: update a single equipment doc in Firestore; onSnapshot syncs UI automatically
  const updEq = (id, fn) => {
    const current = equipment.find(e => e.id === id);
    if (!current) return;
    const updated = fn(current);
    const { id: _id, ...data } = updated;
    setDoc(doc(db, "equipment", String(id)), data).catch(console.error);
  };

  function deleteEquipment(id) {
    deleteDoc(doc(db, "equipment", String(id)))
      .then(() => setView("list"))
      .catch((err) => {
        console.error("Delete failed:", err);
        window.alert("Could not delete this PO. Check your internet connection or Firestore permissions. Error: " + err.message);
      });
  }

  // ── Equipment CRUD ──
  function addEquipment() {
    const po = generatePO(equipment);
    const docFolders = {};
    DOC_FOLDERS.forEach(f => docFolders[f] = []);
    const id = String(Date.now() + Math.random());
    const entry = {
      poNumber:po, make:newEquip.make, model:newEquip.model, year:newEquip.year,
      serialNumber:newEquip.serialNumber, hours:newEquip.hours,
      purchasePrice:parseFloat(newEquip.purchasePrice)||0,
      purchaseFrom:newEquip.purchaseFrom, soldTo:"", salePrice:null, saleDate:null,
      equipType:newEquip.equipType, notes:newEquip.notes,
      status:newEquip.isTradeIn?"Trade-In":"Active", isTradeIn:newEquip.isTradeIn||false,
      tradeOnPoNumber:newEquip.tradeOnPoNumber||"",
      tradeAllowance:newEquip.tradeAllowance?parseFloat(newEquip.tradeAllowance):null,
      checkNumber:newEquip.checkNumber||"",
      costs:[], docs:docFolders, dateAdded:new Date().toISOString().slice(0,10),
    };
    setDoc(doc(db, "equipment", id), entry).catch(console.error);
    setNE({ make:"", model:"", year:"", serialNumber:"", hours:"", purchasePrice:"", purchaseFrom:"", checkNumber:"", equipType:"Farm", notes:"", isTradeIn:false, tradeOnPoNumber:"", tradeAllowance:"" });
    setView("list");
  }

  function addCost(costData) {
    if (!costData.amount || !costData.description) return;
    updEq(selectedId, e => ({ ...e, costs: [...e.costs, { id:Date.now(), ...costData, amount:parseFloat(costData.amount) }] }));
    setNC({ category:"Trucking", description:"", amount:"", date:new Date().toISOString().slice(0,10) });
    setShowAddCost(false);
  }

  function deleteCost(costId) {
    updEq(selectedId, e => ({ ...e, costs: e.costs.filter(c => c.id !== costId) }));
  }

  function markSold() {
    if (!sellInfo.salePrice) return;
    const poNum = equipment.find(e => e.id === selectedId)?.poNumber;
    updEq(selectedId, e => ({ ...e, status:"Sold", salePrice:parseFloat(sellInfo.salePrice), soldTo:sellInfo.soldTo, saleDate:sellInfo.saleDate }));
    // Flip linked trade-ins to Active
    if (poNum) {
      equipment.filter(e => e.isTradeIn && e.tradeOnPoNumber === poNum && e.status === "Trade-In")
        .forEach(e => {
          const { id, ...data } = e;
          setDoc(doc(db, "equipment", String(id)), { ...data, status:"Active" }).catch(console.error);
        });
    }
    setShowSell(false);
    setSI({ salePrice:"", soldTo:"", saleDate:new Date().toISOString().slice(0,10) });
  }

  function toggleSoldInline(id, salePrice) {
    const eq = equipment.find(e => e.id === id);
    if (!eq) return;
    if (eq.status === "Sold") {
      updEq(id, e => ({ ...e, status: e.isTradeIn?"Trade-In":"Active", salePrice:null, soldTo:"", saleDate:null }));
      equipment.filter(e => e.isTradeIn && e.tradeOnPoNumber === eq.poNumber && e.status === "Active")
        .forEach(e => {
          const { id: eid, ...data } = e;
          setDoc(doc(db, "equipment", String(eid)), { ...data, status:"Trade-In" }).catch(console.error);
        });
    } else {
      if (!salePrice) return;
      updEq(id, e => ({ ...e, status:"Sold", salePrice:parseFloat(salePrice)||0, saleDate:new Date().toISOString().slice(0,10) }));
      equipment.filter(e => e.isTradeIn && e.tradeOnPoNumber === eq.poNumber && e.status === "Trade-In")
        .forEach(e => {
          const { id: eid, ...data } = e;
          setDoc(doc(db, "equipment", String(eid)), { ...data, status:"Active" }).catch(console.error);
        });
    }
  }

  // ── Logistics functions ──
  function addLogisticsItem() {
    const id = String(Date.now() + Math.random());
    const entry = {
      make: newLogItem.make, model: newLogItem.model, year: newLogItem.year,
      serialNumber: newLogItem.serialNumber, hours: newLogItem.hours,
      price: parseFloat(newLogItem.price) || 0, dealerName: newLogItem.dealerName,
      location: newLogItem.location, equipType: newLogItem.equipType,
      notes: newLogItem.notes, paid: false, readyForPickup: false,
      dateAdded: new Date().toISOString().slice(0,10),
    };
    setDoc(doc(db, "logistics", id), entry).catch(console.error);
    setNLI({ make:"", model:"", year:"", serialNumber:"", hours:"", price:"", dealerName:"", location:"", equipType:"Farm", notes:"" });
    setShowAddLogistics(false);
  }

  function deleteLogisticsItem(id) {
    deleteDoc(doc(db, "logistics", String(id))).catch((err) => {
      console.error("Delete failed:", err);
      window.alert("Could not delete this item. Check your internet connection or Firestore permissions. Error: " + err.message);
    });
  }

  function startEditLogItem(item) {
    setEditLogId(item.id);
    setEditLogData({ ...item });
  }

  function saveEditLogItem() {
    if (!editLogId) return;
    const { id, ...data } = editLogData;
    data.price = parseFloat(data.price) || 0;
    setDoc(doc(db, "logistics", String(editLogId)), data).catch(console.error);
    setEditLogId(null);
    setEditLogData({});
  }

  function cancelEditLogItem() {
    setEditLogId(null);
    setEditLogData({});
  }

  function togglePaid(id) {
    const item = logisticsItems.find(i => i.id === id);
    if (!item) return;
    const { id: _id, ...data } = item;
    setDoc(doc(db, "logistics", String(id)), { ...data, paid: !item.paid }).catch(console.error);
  }

  function toggleReadyForPickup(id) {
    const item = logisticsItems.find(i => i.id === id);
    if (!item) return;
    const { id: _id, ...data } = item;
    setDoc(doc(db, "logistics", String(id)), { ...data, readyForPickup: !item.readyForPickup }).catch(console.error);
  }

  function moveToInventory(id) {
    const item = logisticsItems.find(i => i.id === id);
    if (!item) {
      window.alert("This item no longer exists in Logistics — it may have already been moved.");
      return;
    }
    if (!item.paid) {
      window.alert("Mark this item as Paid before moving it to Inventory.");
      return;
    }
    const docFolders = {};
    DOC_FOLDERS.forEach(f => docFolders[f] = []);
    const po = generatePO(equipment);
    const newId = String(Date.now() + Math.random());
    const inventoryEntry = {
      poNumber: po, make: item.make, model: item.model, year: item.year,
      serialNumber: item.serialNumber, hours: item.hours, purchasePrice: item.price,
      purchaseFrom: item.dealerName || item.location || "", soldTo: "",
      salePrice: null, saleDate: null, equipType: item.equipType,
      notes: item.notes || "", status: "Active", isTradeIn: false,
      tradeOnPoNumber: "", tradeAllowance: null, costs: [], docs: docFolders,
      dateAdded: new Date().toISOString().slice(0,10),
      fromLogistics: true, logisticsLocation: item.location, logisticsDealerName: item.dealerName,
    };
    setDoc(doc(db, "equipment", newId), inventoryEntry)
      .then(() => {
        deleteDoc(doc(db, "logistics", String(id))).catch((err) => {
          console.error("Failed to remove from logistics:", err);
          window.alert("Moved to Inventory, but could not remove from Logistics list. You may need to delete it manually. Error: " + err.message);
        });
      })
      .catch((err) => {
        console.error("Failed to move to inventory:", err);
        window.alert("Could not move this item to Inventory. Check your internet connection or Firestore permissions. Error: " + err.message);
      });
  }

  function addTradeIn() {
    const tradePoNumber = selected.poNumber;
    const val = parseFloat(tradeInfo.tradeAllowance) || 0;
    updEq(selectedId, e => ({
      ...e, tradeAllowance: val,
      tradeInDescription: `${tradeInfo.year} ${tradeInfo.make} ${tradeInfo.model}`.trim(),
      tradeInDate: new Date().toISOString().slice(0,10),
    }));
    const docFolders = {};
    DOC_FOLDERS.forEach(f => docFolders[f] = []);
    const po = generatePO(equipment);
    const tradeId = String(Date.now() + Math.random());
    setDoc(doc(db, "equipment", tradeId), {
      poNumber:po, make:tradeInfo.make, model:tradeInfo.model, year:tradeInfo.year,
      serialNumber:tradeInfo.serialNumber, hours:tradeInfo.hours, purchasePrice:val,
      purchaseFrom:`Trade on ${tradePoNumber}`, soldTo:"", salePrice:null, saleDate:null,
      equipType:tradeInfo.equipType, notes:tradeInfo.notes, status:"Trade-In",
      isTradeIn:true, tradeOnPoNumber:tradePoNumber, tradeAllowance:val,
      costs:[], docs:docFolders, dateAdded:new Date().toISOString().slice(0,10),
    }).catch(console.error);
    setTI({ make:"", model:"", year:"", serialNumber:"", hours:"", tradeAllowance:"", equipType:"Farm", notes:"" });
    setShowTradeIn(false);
  }

  function removeTradeIn() {
    updEq(selectedId, e => ({ ...e, tradeAllowance: null, tradeInDescription: "", tradeInDate: "" }));
    const linked = equipment.find(e => e.isTradeIn && e.tradeOnPoNumber === selected.poNumber);
    if (linked) deleteDoc(doc(db, "equipment", String(linked.id))).catch(console.error);
  }

  // ── Receipt / Document upload ──
  const handleFileSelect = useCallback(async (files, folder) => {
    if (!files || !files.length) return;
    const file = files[0];
    const mimeType = file.type || "image/jpeg";
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(",")[1];
      const preview = dataUrl;
      const docEntry = { id: Date.now()+Math.random(), name: file.name, preview, folder, uploadedAt: new Date().toISOString().slice(0,10), aiScanned: false, extractedAmount: null, extractedVendor: "", extractedDesc: "", extractedCategory: "Other" };

      if (folder === DOC_FOLDERS[0]) {
        // Expense Receipts → AI scan
        setScanLoading(true);
        setPendingUpload({ base64, mimeType, name: file.name, folder, preview, docEntry });
        setScanResult(null);
        setShowReceiptModal(folder);
        const result = await scanReceiptWithAI(base64, mimeType);
        setScanLoading(false);
        if (result) {
          setScanResult(result);
        }
      } else {
        // Non-expense folders → just store without AI
        updEq(selectedId, e => {
          const docs = { ...e.docs };
          docs[folder] = [...(docs[folder]||[]), docEntry];
          return { ...e, docs };
        });
      }
    };
    reader.readAsDataURL(file);
  }, [selectedId]);

  function confirmReceiptSave(overrideAmount) {
    if (!pendingUpload || !scanResult) return;
    const { docEntry, folder } = pendingUpload;
    // Use manual override amount if provided, otherwise use AI amount
    const finalAmount = overrideAmount != null
      ? (parseFloat(overrideAmount) || 0)
      : (scanResult.total || 0);
    const confirmed = {
      ...docEntry,
      aiScanned: true,
      extractedAmount: finalAmount,
      extractedVendor: scanResult.vendor || "",
      extractedDesc: scanResult.description || "",
      extractedCategory: scanResult.category || "Other",
      extractedDate: scanResult.date || docEntry.uploadedAt,
      manuallyEdited: overrideAmount != null,
    };
    // Add doc to folder
    updEq(selectedId, e => {
      const docs = { ...e.docs };
      docs[folder] = [...(docs[folder]||[]), confirmed];
      return { ...e, docs };
    });
    // Auto-add cost if amount > 0
    if (finalAmount > 0) {
      const costEntry = {
        id: Date.now(),
        category: scanResult.category || "Other",
        description: `${scanResult.vendor ? scanResult.vendor+": " : ""}${scanResult.description || "Receipt"}`,
        amount: finalAmount,
        date: scanResult.date || new Date().toISOString().slice(0,10),
        fromReceipt: true,
        receiptId: confirmed.id,
      };
      updEq(selectedId, e => ({ ...e, costs: [...e.costs, costEntry] }));
    }
    setScanResult(null);
    setPendingUpload(null);
    setManualAmount("");
    setShowReceiptModal(null);
  }

  function deleteDoc(folder, docId) {
    updEq(selectedId, e => {
      const docs = { ...e.docs };
      docs[folder] = (docs[folder]||[]).filter(d => d.id !== docId);
      return { ...e, docs };
    });
  }

  // ── Filtered list ──
  const filtered = useMemo(() => equipment.filter(e => {
    const ms = filterStatus === "All" || e.status === filterStatus;
    const q = searchQ.toLowerCase();
    const mq = !q || e.poNumber.toLowerCase().includes(q) || e.make.toLowerCase().includes(q) || e.model.toLowerCase().includes(q) || (e.serialNumber||"").toLowerCase().includes(q);
    return ms && mq;
  }), [equipment, filterStatus, searchQ]);

  // ── Monthly report data ──
  const reportData = useMemo(() => {
    const [ry, rm] = reportMonth.split("-").map(Number);
    const sold = equipment.filter(e => {
      if (e.status !== "Sold" || !e.saleDate) return false;
      const [sy, sm] = e.saleDate.split("-").map(Number);
      return sy === ry && sm === rm;
    });
    const rows = sold.map(e => {
      const { totalIn, margin } = getTotals(e);
      return { ...e, totalIn, margin };
    });
    const totalRevenue = rows.reduce((s,r) => s+(r.salePrice||0), 0);
    const totalCostIn = rows.reduce((s,r) => s+r.totalIn, 0);
    const totalProfit = rows.reduce((s,r) => s+(r.margin||0), 0);
    return { rows, totalRevenue, totalCostIn, totalProfit };
  }, [equipment, reportMonth]);

  // ── Memoized map HTML — only recalculates when logisticsItems change ──
  const logisticsMapHtml = useMemo(() => {
    const withLocation = logisticsItems.filter(i => i.location && i.location.trim());
    if (withLocation.length === 0) return "";
    const items = JSON.stringify(withLocation.map(i => ({
      location: i.location,
      label: i.make + " " + i.model + (i.year ? " (" + i.year + ")" : "") + (i.dealerName ? "\n" + i.dealerName : "") + (i.price ? "\n$" + Number(i.price).toLocaleString() : ""),
      ready: !!i.readyForPickup
    })));
    return `<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
*{box-sizing:border-box}
html,body,#map{margin:0;padding:0;width:100%;height:100%;background:#0f1923}
.leaflet-popup-content-wrapper{background:#1a2a3a;color:#e8dcc8;border:1px solid #b45309;border-radius:10px;box-shadow:0 4px 20px #0006}
.leaflet-popup-tip{background:#1a2a3a}
.leaflet-popup-content{font-family:system-ui,sans-serif;font-size:13px;line-height:1.6;margin:10px 14px}
.leaflet-popup-close-button{color:#9a8a74!important}
.pin-label{display:inline-block;background:#0f1923;color:#f5a623;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;margin-top:4px;letter-spacing:.05em}
</style>
</head><body><div id="map"></div>
<script>
var items = ${items};
var map = L.map('map',{zoomControl:true,attributionControl:true}).setView([39.5,-98.35],4);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
  attribution:'© Esri © USGS © NASA',maxZoom:19
}).addTo(map);
// Labels overlay so city/road names show on top of satellite imagery
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',{
  attribution:'',maxZoom:19,opacity:0.8
}).addTo(map);

function makePinIcon(ready, num){
  var bg = ready ? '#22c55e' : '#ef4444';
  var shadow = ready ? '#16a34a88' : '#dc262688';
  var html = '<div style="position:relative;width:32px;height:40px">'
    + '<div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-top:10px solid '+bg+'"></div>'
    + '<div style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:28px;height:28px;border-radius:50%;background:'+bg+';border:3px solid #fff;box-shadow:0 2px 8px '+shadow+';display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;font-family:system-ui">'+num+'</div>'
    + '</div>';
  return L.divIcon({className:'',html:html,iconSize:[32,40],iconAnchor:[16,40],popupAnchor:[0,-42]});
}

var allMarkers = [];
var done = 0;

items.forEach(function(item, idx){
  var url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&q='+encodeURIComponent(item.location);
  fetch(url).then(function(r){return r.json();}).then(function(data){
    if(data && data[0]){
      var lat = parseFloat(data[0].lat);
      var lon = parseFloat(data[0].lon);
      var num = idx + 1;
      var statusHtml = item.ready
        ? '<div style="color:#22c55e;font-weight:700;font-size:12px;margin-top:4px">✓ Ready for Pickup</div>'
        : '<div style="color:#f87171;font-size:12px;margin-top:4px">⏳ Awaiting Pickup</div>';
      var popupHtml = '<div style="min-width:160px">'
        + '<div class="pin-label">PIN '+num+'</div>'
        + '<div style="font-weight:700;font-size:14px;color:#f5e6c8;margin-top:6px">'+item.label.replace(/\n/g,'<br/>')+'</div>'
        + statusHtml
        + '<div style="color:#7a8a9a;font-size:11px;margin-top:4px">📍 '+item.location+'</div>'
        + '<div style="margin-top:8px"><a href="https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(item.location)+'" target="_blank" style="color:#60a5fa;font-size:12px;font-weight:600;text-decoration:none">Open in Google Maps →</a></div>'
        + '</div>';
      var marker = L.marker([lat,lon],{icon:makePinIcon(item.ready, num)})
        .addTo(map)
        .bindPopup(popupHtml,{maxWidth:260});
      allMarkers.push(marker);
    }
    done++;
    if(done === items.length && allMarkers.length > 0){
      var group = L.featureGroup(allMarkers);
      if(allMarkers.length === 1){
        map.setView(allMarkers[0].getLatLng(), 9);
      } else {
        map.fitBounds(group.getBounds().pad(0.25));
      }
    }
  }).catch(function(){
    done++;
  });
});
<\/script></body></html>`;
  }, [logisticsItems]);

  // ── Dashboard stats ──
  const stats = useMemo(() => {
    const active = equipment.filter(e => e.status === "Active");
    const tradeIns = equipment.filter(e => e.status === "Trade-In");
    const sold = equipment.filter(e => e.status === "Sold");
    const totalInvested = [...active,...tradeIns].reduce((s,e) => s+getTotals(e).totalIn, 0);
    const totalProfit = sold.reduce((s,e) => s+(getTotals(e).margin||0), 0);
    const totalRevenue = sold.reduce((s,e) => s+(e.salePrice||0), 0);
    const logisticsPending = logisticsItems.length;
    const logisticsValue = logisticsItems.reduce((s,i) => s+i.price, 0);
    return { active:active.length, tradeIns:tradeIns.length, sold:sold.length, totalInvested, totalProfit, totalRevenue, logisticsPending, logisticsValue };
  }, [equipment, logisticsItems]);

  // ══════════════════════════════════════════════════════════════════════════════
  // VIEWS
  // ══════════════════════════════════════════════════════════════════════════════

  const renderDashboard = () => {
    return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <div>
          <h2 style={{ margin:0, fontSize:22, fontWeight:800, color:"#edf2fc" }}>Dashboard</h2>
          <p style={{ margin:"4px 0 0", color:"#7a8aaa", fontSize:13 }}>{equipment.length} total units in system</p>
        </div>
        <button style={S.btn("primary")} onClick={() => setView("add")}>+ Add Equipment</button>
      </div>
      <div style={S.statGrid}>
        {[
          { val:stats.active,   lbl:"Active Inventory",  c:"#4ade80", click:()=>{ setFilterStatus("Active");   setView("list"); } },
          { val:stats.tradeIns, lbl:"Trade-Ins",         c:"#facc15", click:()=>{ setFilterStatus("Trade-In"); setView("list"); } },
          { val:stats.sold,     lbl:"Units Sold",        c:"#f87171", click:()=>{ setFilterStatus("Sold");     setView("list"); } },
          { val:stats.logisticsPending, lbl:"Logistics Pending", c:"#6abf4a", click:()=>setView("logistics") },
          { val:fmt(stats.totalInvested), lbl:"$ In Active Units", c:"#d4a817", sm:true, click:()=>{ setFilterStatus("Active"); setView("list"); } },
          { val:fmt(stats.totalRevenue),  lbl:"Total Revenue",     c:"#d4a817", sm:true, click:()=>{ setFilterStatus("Sold");   setView("list"); } },
          { val:fmt(stats.totalProfit),   lbl:"Total Profit",      c:stats.totalProfit>=0?"#4ade80":"#f87171", sm:true, click:()=>{ setFilterStatus("Sold"); setView("list"); } },
        ].map(({val,lbl,c,sm,click}) => (
          <div key={lbl} style={{...S.statCard(c), cursor:"pointer", userSelect:"none"}} onClick={click}>
            <div style={{...S.statVal(c), fontSize:sm?19:26}}>{val}</div>
            <div style={S.statLbl}>{lbl}</div>
          </div>
        ))}
      </div>
      <div style={S.card}>
        <div style={S.secTitle}>Recent Inventory</div>
        {equipment.length === 0
          ? <div style={{ color:"#4a5a7a", textAlign:"center", padding:"30px 0" }}>No equipment yet. Click "+ Add Equipment" to start.</div>
          : equipment.slice(0,6).map(e => {
              const { totalIn, margin } = getTotals(e);
              return (
                <div key={e.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #2a3055", cursor:"pointer" }} onClick={() => { setSelectedId(e.id); setView("detail"); }}>
                  <span style={S.poTag}>{e.poNumber}</span>
                  <div style={{ flex:1 }}>
                    <span style={{ fontWeight:600, color:"#edf2fc" }}>{e.year} {e.make} {e.model}</span>
                    <span style={{ color:"#4a5a7a", fontSize:12, marginLeft:8 }}>{e.equipType}</span>
                  </div>
                  <span style={S.badge(e.status)}>{e.status}</span>
                  <div style={{ textAlign:"right", minWidth:100 }}>
                    <div style={{ fontSize:13, color:"#d4a817", fontWeight:700 }}>{fmt(totalIn)}</div>
                    <div style={{ fontSize:11, color:"#4a5a7a" }}>total in</div>
                  </div>
                  {e.status==="Sold" && <div style={{ textAlign:"right", minWidth:90 }}><div style={{ color:margin>=0?"#4ade80":"#f87171", fontWeight:700 }}>{fmt(margin)}</div><div style={{ fontSize:11, color:"#4a5a7a" }}>profit</div></div>}
                </div>
              );
            })
        }
        {equipment.length > 6 && <button style={{...S.btn("ghost"), marginTop:12}} onClick={()=>setView("list")}>View all {equipment.length} units →</button>}
      </div>
    </div>
    );
  };

  // ── List View with Sold Toggles ──
  const renderList = () => {
    return (
      <div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <h2 style={{ margin:0, fontSize:20, fontWeight:800, color:"#edf2fc" }}>All Inventory</h2>
          <button style={S.btn("primary")} onClick={()=>setView("add")}>+ Add Equipment</button>
        </div>
        <div style={{ background:"#131828", border:"1px solid #b4530940", borderRadius:8, padding:"12px 16px", marginBottom:16, display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:18 }}>💡</span>
          <span style={{ color:"#8a9aba", fontSize:13 }}>Use the <strong style={{color:"#d4a817"}}>Sold</strong> toggle on each row to quickly mark units sold at month-end, then run a <strong style={{color:"#d4a817"}}>Monthly Report</strong>.</span>
        </div>
        <div style={{ display:"flex", gap:10, marginBottom:16, flexWrap:"wrap" }}>
          <input style={{...S.input, width:220}} placeholder="Search PO, make, model, serial…" value={searchQ} onChange={e=>setSearchQ(e.target.value)} />
          {["All","Active","Trade-In","Sold"].map(s => <button key={s} style={{...S.btn(filterStatus===s?"primary":"ghost"), padding:"8px 14px"}} onClick={()=>setFilterStatus(s)}>{s}</button>)}
        </div>
        {filtered.length === 0
          ? <div style={{ color:"#4a5a7a", textAlign:"center", padding:"40px 0" }}>No units match your filter.</div>
          : filtered.map(e => {
              const { totalIn, margin } = getTotals(e);
              const isSold = e.status === "Sold";
              return (
                <div key={e.id} style={{ background:"#1e2436", border:`1px solid ${isSold?"#7f1d1d40":"#252c48"}`, borderRadius:8, marginBottom:6, padding:"10px 14px" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                    {/* Left: PO + name clickable */}
                    <div style={{ flex:1, minWidth:200, cursor:"pointer" }} onClick={()=>{ setSelectedId(e.id); setView("detail"); }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2 }}>
                        <span style={S.poTag}>{e.poNumber}</span>
                        <span style={S.badge(e.status)}>{e.status}</span>
                      </div>
                      <div style={{ fontWeight:600, color:"#edf2fc" }}>{e.year} {e.make} {e.model}</div>
                      <div style={{ fontSize:11, color:"#4a5a7a" }}>S/N: {e.serialNumber||"—"} · {fmtNum(e.hours)} hrs · {e.equipType}</div>
                    </div>
                    {/* Financials */}
                    <div style={{ display:"flex", gap:20, alignItems:"center", flexWrap:"wrap" }}>
                      <div style={{ textAlign:"right" }}>
                        <div style={{ fontSize:12, color:"#7a8aaa" }}>Total In</div>
                        <div style={{ color:"#d4a817", fontWeight:700 }}>{fmt(totalIn)}</div>
                      </div>
                      {isSold && <>
                        <div style={{ textAlign:"right" }}>
                          <div style={{ fontSize:12, color:"#7a8aaa" }}>Sale Price</div>
                          <div style={{ color:"#4ade80", fontWeight:700 }}>{fmt(e.salePrice)}</div>
                        </div>
                        <div style={{ textAlign:"right" }}>
                          <div style={{ fontSize:12, color:"#7a8aaa" }}>Profit</div>
                          <div style={{ color:margin>=0?"#4ade80":"#f87171", fontWeight:700 }}>{fmt(margin)}</div>
                        </div>
                      </>}
                      {!isSold && (
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <input
                            style={{...S.input, width:110, padding:"5px 8px"}}
                            type="number"
                            placeholder="Sale price"
                            value={localPrices[e.id]||""}
                            onChange={ev => setLP(p=>({...p,[e.id]:ev.target.value}))}
                            onClick={ev=>ev.stopPropagation()}
                          />
                        </div>
                      )}
                      {/* Sold toggle */}
                      <div onClick={ev=>ev.stopPropagation()}>
                        <Toggle
                          checked={isSold}
                          color="#f87171"
                          label={isSold?"Sold":"Mark Sold"}
                          onChange={() => {
                            if (isSold) {
                              toggleSoldInline(e.id);
                            } else {
                              const p = localPrices[e.id];
                              if (!p) return;
                              toggleSoldInline(e.id, p);
                            }
                          }}
                        />
                      </div>
                    </div>
                  </div>
                  {isSold && e.saleDate && <div style={{ fontSize:11, color:"#4a5a7a", marginTop:4 }}>Sold {e.saleDate}{e.soldTo ? ` to ${e.soldTo}` : ""}</div>}
                </div>
              );
            })
        }
      </div>
    );
  };

  // ── Monthly Report View ──
  const renderReport = () => {
    const [ry, rm] = reportMonth.split("-").map(Number);
    const monthLabel = `${MONTHS[rm-1]} ${ry}`;
    const { rows, totalRevenue, totalCostIn, totalProfit } = reportData;

    return (
      <div>
        <h2 style={{ margin:"0 0 6px", fontSize:20, fontWeight:800, color:"#edf2fc" }}>Monthly Sales Report</h2>
        <p style={{ margin:"0 0 20px", color:"#7a8aaa", fontSize:13 }}>Select a month to see all units sold and their profit/loss.</p>

        {/* Month picker */}
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:24 }}>
          <div>
            <label style={S.label}>Report Month</label>
            <input style={{...S.input, width:180}} type="month" value={reportMonth} onChange={e=>setReportMonth(e.target.value)} />
          </div>
          <div style={{ marginTop:16, color:"#8a9aba", fontSize:13 }}>{rows.length} unit{rows.length!==1?"s":""} sold in {monthLabel}</div>
        </div>

        {/* Summary cards */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:12, marginBottom:24 }}>
          <div style={S.statCard("#d4a817")}><div style={{...S.statVal("#d4a817"),fontSize:20}}>{rows.length}</div><div style={S.statLbl}>Units Sold</div></div>
          <div style={S.statCard("#4ade80")}><div style={{...S.statVal("#4ade80"),fontSize:20}}>{fmt(totalRevenue)}</div><div style={S.statLbl}>Total Revenue</div></div>
          <div style={S.statCard("#f87171")}><div style={{...S.statVal("#f87171"),fontSize:20}}>{fmt(totalCostIn)}</div><div style={S.statLbl}>Total Cost In</div></div>
          <div style={S.statCard(totalProfit>=0?"#4ade80":"#f87171")}><div style={{...S.statVal(totalProfit>=0?"#4ade80":"#f87171"),fontSize:20}}>{fmt(totalProfit)}</div><div style={S.statLbl}>Net Profit / Loss</div></div>
        </div>

        {rows.length === 0 ? (
          <div style={{ ...S.card, textAlign:"center", color:"#4a5a7a", padding:"40px 20px" }}>
            No units sold in {monthLabel}. Mark units as sold from the Inventory view.
          </div>
        ) : (
          <div style={S.card}>
            <div style={S.secTitle}>{monthLabel} — Sold Units Detail</div>
            {/* Header row */}
            <div style={{ display:"grid", gridTemplateColumns:"120px 1fr 110px 110px 110px 100px", gap:8, padding:"6px 8px", color:"#4a5a7a", fontSize:11, textTransform:"uppercase", letterSpacing:"0.06em", borderBottom:"1px solid #2a3055", marginBottom:4 }}>
              <span>PO #</span><span>Unit</span><span>Total In</span><span>Sale Price</span><span>Profit / Loss</span><span>Margin</span>
            </div>
            {rows.map(r => (
              <div key={r.id} style={{ display:"grid", gridTemplateColumns:"120px 1fr 110px 110px 110px 100px", gap:8, padding:"10px 8px", borderBottom:"1px solid #2a3055", cursor:"pointer", alignItems:"center" }}
                onClick={()=>{ setSelectedId(r.id); setView("detail"); }}>
                <span style={S.poTag}>{r.poNumber}</span>
                <div>
                  <div style={{ fontWeight:600, color:"#edf2fc" }}>{r.year} {r.make} {r.model}</div>
                  <div style={{ fontSize:11, color:"#4a5a7a" }}>Sold {r.saleDate}{r.soldTo?` · ${r.soldTo}`:""}</div>
                </div>
                <span style={{ color:"#d4a817" }}>{fmt(r.totalIn)}</span>
                <span style={{ color:"#4ade80" }}>{fmt(r.salePrice)}</span>
                <span style={{ color:r.margin>=0?"#4ade80":"#f87171", fontWeight:700 }}>{fmt(r.margin)}</span>
                <span style={{ color:r.marginPct>=0?"#4ade80":"#f87171", fontSize:13 }}>{r.marginPct!=null?r.marginPct.toFixed(1)+"%":"—"}</span>
              </div>
            ))}
            {/* Grand total row */}
            <div style={{ display:"grid", gridTemplateColumns:"120px 1fr 110px 110px 110px 100px", gap:8, padding:"12px 8px", borderTop:"2px solid #b45309", marginTop:8, background:"#111520", borderRadius:6 }}>
              <span />
              <span style={{ fontWeight:800, color:"#edf2fc", fontSize:14 }}>GRAND TOTAL</span>
              <span style={{ color:"#d4a817", fontWeight:700 }}>{fmt(totalCostIn)}</span>
              <span style={{ color:"#4ade80", fontWeight:700 }}>{fmt(totalRevenue)}</span>
              <span style={{ color:totalProfit>=0?"#4ade80":"#f87171", fontWeight:900, fontSize:15 }}>{fmt(totalProfit)}</span>
              <span style={{ color:totalProfit>=0?"#4ade80":"#f87171", fontSize:13, fontWeight:700 }}>{totalRevenue>0?((totalProfit/totalRevenue)*100).toFixed(1)+"%":"—"}</span>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── Detail View ──
  const renderDetail = () => {
    if (!selected) return null;
    const { totalCosts, totalIn, margin, marginPct, tradeAllowance, cashDue } = getTotals(selected);
    // Exclude legacy trade allowance costs from display — trade allowance now shown on sale side
    const costsByCategory = COST_CATEGORIES.map(cat => {
      const items = (selected.costs||[]).filter(c => c.category === cat && !c.isTradeAllowance);
      return { cat, items, total: items.reduce((s,c)=>s+c.amount,0) };
    }).filter(g => g.items.length > 0);

    const folderDocs = (selected.docs||{})[activeFolder] || [];
    const totalFolderDocs = DOC_FOLDERS.reduce((s,f)=>s+((selected.docs||{})[f]||[]).length,0);

    return (
      <div>
        <button style={{...S.btn("ghost"), marginBottom:16}} onClick={()=>{setView("list"); setEditingPO(false);}}>← Back to Inventory</button>

        {/* PO Header */}
        <div style={{ background:"#111520", border:"2px solid #b45309", borderRadius:12, padding:24, marginBottom:16 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:12 }}>
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6, flexWrap:"wrap" }}>
                {editingPO ? (
                  <div style={{display:"flex", alignItems:"center", gap:6}}>
                    <input
                      value={editingPOValue}
                      onChange={e => setEditingPOValue(e.target.value)}
                      autoFocus
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck="false"
                      style={{...S.input, fontFamily:"monospace", fontSize:15, fontWeight:700, color:"#d4a817", background:"#111520", border:"2px solid #b45309", borderRadius:6, padding:"4px 12px", width:160, letterSpacing:"0.08em"}}
                    />
                    <button
                      onClick={() => {
                        const newPO = editingPOValue.trim();
                        if (!newPO) { setEditingPO(false); return; }
                        const duplicate = equipment.some(e => e.id !== selected.id && e.poNumber === newPO);
                        if (duplicate) { setEditingPOValue(selected.poNumber); setEditingPO(false); return; }
                        updEq(selected.id, e => ({ ...e, poNumber: newPO }));
                        setEditingPO(false);
                      }}
                      style={{...S.btn("success"), padding:"4px 12px", fontSize:12}}>Save</button>
                    <button
                      onClick={() => { setEditingPO(false); setEditingPOValue(selected.poNumber); }}
                      style={{...S.btn("ghost"), padding:"4px 10px", fontSize:12}}>✕</button>
                  </div>
                ) : (
                  <div style={{display:"flex", alignItems:"center", gap:6}}>
                    <span style={{...S.poTag, fontSize:16, padding:"4px 14px"}}>{selected.poNumber}</span>
                    <button
                      onClick={() => { setEditingPOValue(selected.poNumber); setEditingPO(true); }}
                      title="Edit PO number"
                      style={{background:"none", border:"1px solid #b4530950", borderRadius:5, color:"#c9a227", cursor:"pointer", fontSize:11, padding:"2px 8px", fontWeight:600}}>
                      ✏️ Edit
                    </button>
                  </div>
                )}
                <span style={S.badge(selected.status)}>{selected.status}</span>
                {selected.isTradeIn && <span style={{ display:"inline-block", padding:"2px 10px", borderRadius:20, fontSize:11, fontWeight:600, background:"#2a2020", color:"#facc15", border:"1px solid #713f12" }}>TRADE-IN</span>}
              </div>
              <h2 style={{ margin:"0 0 4px", fontSize:26, fontWeight:900, color:"#edf2fc" }}>{selected.year} {selected.make} {selected.model}</h2>
              <div style={{ color:"#7a8aaa", fontSize:13 }}>{selected.equipType} Equipment · Added {selected.dateAdded}</div>
            </div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              {selected.status !== "Sold" && <>
                <button style={S.btn("secondary")} onClick={()=>setShowAddCost(true)}>+ Add Cost</button>
                <button style={S.btn("secondary")} onClick={()=>setShowTradeIn(true)}>+ Trade-In</button>
                <button style={S.btn("success")} onClick={()=>setShowSell(true)}>Mark Sold</button>
              </>}
              <button
                style={{...S.btn("ghost"), border:"1px solid #c9a227", color:"#c9a227", fontSize:13}}
                onClick={()=>{ setInvoiceSelectedId(selected.id); setView("invoice"); }}>
                🧾 Invoice
              </button>
              <button
                style={{...S.btn("danger"), fontSize:12}}
                onClick={()=>deleteEquipment(selected.id)}>
                🗑 Delete PO
              </button>
            </div>
          </div>
          <hr style={S.divider} />
          <div style={S.grid3}>
            <div><span style={S.label}>Make</span><span style={{color:"#edf2fc"}}>{selected.make||"—"}</span></div>
            <div><span style={S.label}>Model</span><span style={{color:"#edf2fc"}}>{selected.model||"—"}</span></div>
            <div><span style={S.label}>Year</span><span style={{color:"#edf2fc"}}>{selected.year||"—"}</span></div>
            <div><span style={S.label}>Serial Number</span><span style={{color:"#edf2fc", fontFamily:"monospace"}}>{selected.serialNumber||"—"}</span></div>
            <div><span style={S.label}>Hours</span><span style={{color:"#edf2fc"}}>{fmtNum(selected.hours)}</span></div>
            <div><span style={S.label}>Type</span><span style={{color:"#edf2fc"}}>{selected.equipType}</span></div>
            <div><span style={S.label}>Purchased From</span><span style={{color:"#edf2fc"}}>{selected.purchaseFrom||"—"}</span></div>
            {selected.soldTo && <div><span style={S.label}>Sold To</span><span style={{color:"#edf2fc"}}>{selected.soldTo}</span></div>}
            {selected.saleDate && <div><span style={S.label}>Sale Date</span><span style={{color:"#edf2fc"}}>{selected.saleDate}</span></div>}
            {selected.isTradeIn && <div><span style={S.label}>Traded On</span><span style={S.poTag}>{selected.tradeOnPoNumber}</span></div>}
            {selected.checkNumber && <div><span style={S.label}>Check Number</span><span style={{color:"#edf2fc", fontFamily:"monospace", fontWeight:600}}>#{selected.checkNumber}</span></div>}
          </div>
          {selected.notes && <div style={{ marginTop:12, padding:"10px 14px", background:"#1e2436", borderRadius:7, color:"#8a9aba", fontSize:13 }}>📋 {selected.notes}</div>}
        </div>

        {/* Financial Summary */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
          <div style={S.statCard("#d4a817")}><div style={S.statLbl}>Purchase Price</div><div style={{...S.statVal("#d4a817"),fontSize:20}}>{fmt(selected.purchasePrice)}</div></div>
          <div style={S.statCard("#d4a817")}><div style={S.statLbl}>Additional Costs</div><div style={{...S.statVal("#d4a817"),fontSize:20}}>{fmt(totalCosts)}</div></div>
          <div style={S.statCard("#c9a227")}><div style={S.statLbl}>Total $ In Unit</div><div style={{...S.statVal("#d4a817"),fontSize:20}}>{fmt(totalIn)}</div></div>
          {selected.status==="Sold"
            ? <>
                <div style={S.statCard("#4ade80")}><div style={S.statLbl}>Sale Price</div><div style={{...S.statVal("#4ade80"),fontSize:20}}>{fmt(selected.salePrice)}</div></div>
                {tradeAllowance > 0 && <>
                  <div style={S.statCard("#facc15")}><div style={S.statLbl}>Trade-In Allowance</div><div style={{...S.statVal("#facc15"),fontSize:20}}>− {fmt(tradeAllowance)}</div></div>
                  <div style={S.statCard("#6abf4a")}><div style={S.statLbl}>Cash Due from Buyer</div><div style={{...S.statVal("#6abf4a"),fontSize:20}}>{fmt(cashDue)}</div></div>
                </>}
                <div style={{...S.statCard(margin>=0?"#4ade80":"#f87171"), gridColumn:"span 2"}}>
                  <div style={S.statLbl}>Net Profit / Loss {tradeAllowance>0 && <span style={{fontSize:10,color:"#8a9aba",fontWeight:400}}>(based on sale price, trade allowance accounted on trade-in PO)</span>}</div>
                  <div style={{...S.statVal(margin>=0?"#4ade80":"#f87171"),fontSize:26}}>{fmt(margin)} <span style={{fontSize:13,fontWeight:400}}>({marginPct?.toFixed(1)}% margin)</span></div>
                </div>
              </>
            : <>
                {tradeAllowance > 0 && (
                  <div style={{...S.statCard("#facc15"), position:"relative"}}>
                    <div style={S.statLbl}>Trade-In Allowance</div>
                    <div style={{...S.statVal("#facc15"),fontSize:20}}>− {fmt(tradeAllowance)}</div>
                    <div style={{fontSize:11,color:"#8a7a30",marginTop:4}}>{selected.tradeInDescription}</div>
                    <button
                      onClick={removeTradeIn}
                      style={{marginTop:10,background:"none",border:"1px solid #7f1d1d",borderRadius:5,color:"#f87171",cursor:"pointer",fontSize:11,padding:"2px 8px",fontWeight:600}}>
                      ✕ Remove Trade-In
                    </button>
                  </div>
                )}
                <div style={S.statCard("#2a3050")}><div style={S.statLbl}>Status</div><div style={{color:"#8a9aba",fontSize:16,fontWeight:600,paddingTop:8}}>Not yet sold</div></div>
              </>
          }
        </div>

        {/* Cost Breakdown */}
        <div style={S.card}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <div style={S.secTitle}>Cost Breakdown</div>
            {selected.status!=="Sold" && <button style={S.btn("primary")} onClick={()=>setShowAddCost(true)}>+ Add Cost</button>}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0", borderBottom:"1px solid #2a3055", color:"#8a9aba" }}>
            <span style={{flex:1,fontSize:13}}>Purchase Price</span>
            <span style={{fontSize:13,color:"#d4a817",fontWeight:600,minWidth:100,textAlign:"right"}}>{fmt(selected.purchasePrice)}</span>
            <span style={{width:28}} />
          </div>
          {costsByCategory.map(({cat,items,total}) => (
            <div key={cat}>
              <div style={{padding:"6px 0 2px",fontSize:11,color:"#c9a227",textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:700}}>{cat}</div>
              {items.map(c => (
                <div key={c.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 0",borderBottom:"1px solid #2a3055"}}>
                  <div style={{flex:1}}>
                    <span style={{color:"#dde4f0",fontSize:13}}>{c.description}</span>
                    {c.fromReceipt && <span style={{marginLeft:6,fontSize:10,background:"#1e2436",color:"#6abf4a",border:"1px solid #1e3a5f",borderRadius:3,padding:"1px 5px"}}>📷 AI</span>}
                    <span style={{color:"#4a5a7a",fontSize:11,marginLeft:8}}>{c.date}</span>
                  </div>
                  <span style={{fontSize:13,color:c.isTradeAllowance?"#facc15":"#d4a817",fontWeight:600,minWidth:100,textAlign:"right"}}>{fmt(c.amount)}</span>
                  {selected.status!=="Sold" && <button onClick={()=>deleteCost(c.id)} style={{background:"none",border:"none",color:"#4a5a7a",cursor:"pointer",fontSize:16,width:28,padding:0}}>×</button>}
                </div>
              ))}
              <div style={{padding:"4px 0",display:"flex",justifyContent:"flex-end",color:"#7a8aaa",fontSize:12}}>
                Subtotal: <span style={{color:"#d4a817",marginLeft:8}}>{fmt(total)}</span>
              </div>
            </div>
          ))}
          <hr style={S.divider} />
          <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0"}}>
            <span style={{fontWeight:700,color:"#edf2fc"}}>TOTAL IN UNIT</span>
            <span style={{fontWeight:800,fontSize:16,color:"#d4a817"}}>{fmt(totalIn)}</span>
          </div>
          {selected.status==="Sold" && <>
            <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0"}}>
              <span style={{fontWeight:700,color:"#edf2fc"}}>SALE PRICE</span>
              <span style={{fontWeight:800,fontSize:16,color:"#4ade80"}}>{fmt(selected.salePrice)}</span>
            </div>
            {tradeAllowance > 0 && <>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0"}}>
                <div>
                  <span style={{fontWeight:600,color:"#facc15"}}>TRADE-IN ALLOWANCE{selected.tradeInDescription ? ` — ${selected.tradeInDescription}` : ""}</span>
                  {selected.status !== "Sold" && (
                    <button onClick={removeTradeIn}
                      style={{marginLeft:10,background:"none",border:"1px solid #7f1d1d",borderRadius:4,color:"#f87171",cursor:"pointer",fontSize:11,padding:"1px 7px",fontWeight:600,verticalAlign:"middle"}}>
                      ✕ Remove
                    </button>
                  )}
                </div>
                <span style={{fontWeight:700,fontSize:15,color:"#facc15"}}>− {fmt(tradeAllowance)}</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0"}}>
                <span style={{fontWeight:700,color:"#6abf4a"}}>CASH DUE FROM BUYER</span>
                <span style={{fontWeight:800,fontSize:16,color:"#6abf4a"}}>{fmt(cashDue)}</span>
              </div>
            </>}
            <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderTop:"2px solid #b45309",marginTop:4}}>
              <span style={{fontWeight:800,color:"#edf2fc",fontSize:15}}>NET PROFIT / LOSS</span>
              <span style={{fontWeight:900,fontSize:18,color:margin>=0?"#4ade80":"#f87171"}}>{fmt(margin)}</span>
            </div>
          </>}
        </div>

        {/* ── Document Folders ── */}
        <div style={{ marginBottom:16 }}>
          <div style={{ display:"flex", alignItems:"flex-end", gap:0, borderBottom:"1px solid #2a3055", marginBottom:0 }}>
            <div style={{ fontSize:11, color:"#c9a227", textTransform:"uppercase", letterSpacing:"0.12em", fontWeight:700, paddingBottom:8, marginRight:12, paddingTop:8 }}>
              📂 Documents {totalFolderDocs > 0 && `(${totalFolderDocs})`}
            </div>
            {DOC_FOLDERS.map(f => (
              <FolderTab key={f} active={activeFolder===f} label={f} count={(selected.docs||{})[f]?.length||0} onClick={()=>setActiveFolder(f)} />
            ))}
          </div>

          <div style={{ background:"#1e2436", border:"1px solid #2a3055", borderTop:"none", borderRadius:"0 0 10px 10px", padding:16 }}>
            {/* Upload button */}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <div style={{ fontSize:12, color:"#7a8aaa" }}>
                {activeFolder === "Expense Receipts"
                  ? "📷 Upload a receipt — AI will extract the amount and add it to costs automatically."
                  : activeFolder === "Tax Exemption Form"
                  ? "📋 Store tax exemption forms for this unit."
                  : "🧾 Store the original purchase receipt/bill of sale."}
              </div>
              <label style={{...S.btn("primary"), cursor:"pointer", display:"inline-block", padding:"7px 14px", fontSize:12}}>
                + Upload {activeFolder === "Expense Receipts" ? "Receipt" : "Document"}
                <input type="file" accept="image/*,application/pdf" style={{display:"none"}} onChange={ev => handleFileSelect(ev.target.files, activeFolder)} />
              </label>
            </div>

            {/* File grid */}
            {folderDocs.length === 0
              ? <div style={{ color:"#2a3a5a", textAlign:"center", padding:"30px 0", fontSize:13 }}>No documents in this folder yet.</div>
              : <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))", gap:12 }}>
                  {folderDocs.map(doc => (
                    <div key={doc.id} style={{ background:"#111520", border:"1px solid #2e3a58", borderRadius:8, overflow:"hidden", cursor:"pointer" }}>
                      <div style={{ position:"relative" }} onClick={()=>setShowDocViewer({src:doc.preview, name:doc.name})}>
                        {doc.preview?.startsWith("data:image")
                          ? <img src={doc.preview} alt={doc.name} style={{width:"100%",height:100,objectFit:"cover",display:"block"}} />
                          : <div style={{width:"100%",height:100,background:"#1e2436",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>📄</div>
                        }
                        {doc.aiScanned && <div style={{ position:"absolute",top:4,right:4,background:"#1e6030",color:"#93d570",fontSize:9,padding:"2px 5px",borderRadius:3,fontWeight:700 }}>AI ✓</div>}
                      </div>
                      <div style={{ padding:"8px 8px 6px" }}>
                        <div style={{ fontSize:11, color:"#8a9aba", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{doc.name}</div>
                        <div style={{ fontSize:10, color:"#4a5a7a" }}>{doc.uploadedAt}</div>
                        {doc.aiScanned && doc.extractedAmount > 0 && (
                          <div style={{ fontSize:12, color:"#4ade80", fontWeight:700, marginTop:2 }}>{fmt(doc.extractedAmount)}</div>
                        )}
                        {doc.aiScanned && doc.extractedVendor && (
                          <div style={{ fontSize:10, color:"#7a8a9a" }}>{doc.extractedVendor}</div>
                        )}
                      </div>
                      <div style={{ borderTop:"1px solid #2a3055", padding:"4px 8px", display:"flex", justifyContent:"flex-end" }}>
                        <button onClick={()=>deleteDoc(activeFolder, doc.id)} style={{background:"none",border:"none",color:"#4a5a7a",cursor:"pointer",fontSize:11,padding:2}}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
            }
          </div>
        </div>
      </div>
    );
  };

  // ── Add View ──


  // ══════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════════
  // ── Logistics View ──
  const renderLogistics = () => {
    const withLocation = logisticsItems.filter(i => i.location && i.location.trim());

    // Google Maps: single = search pin, multiple = directions with a stop at each location (shows pin at each)
    const googleMapsUrl = withLocation.length === 0 ? "#"
      : withLocation.length === 1
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(withLocation[0].location)}`
      : `https://www.google.com/maps/dir/${withLocation.map(i=>encodeURIComponent(i.location)).join('/')}`;


    return (
      <div>
        {/* Header */}
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16}}>
          <div>
            <h2 style={{margin:0, fontSize:22, fontWeight:800, color:"#edf2fc"}}>Logistics</h2>
            <p style={{margin:"4px 0 0", color:"#7a8aaa", fontSize:13}}>Equipment purchased, not yet picked up.</p>
          </div>
          <button style={{...S.btn("primary"), padding:"10px 16px"}} onClick={()=>setShowAddLogistics(true)}>+ Add</button>
        </div>

        {/* Stats */}
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:16}}>
          <div style={S.statCard("#d4a817")}><div style={{...S.statVal("#d4a817"),fontSize:20}}>{logisticsItems.length}</div><div style={S.statLbl}>Pending</div></div>
          <div style={S.statCard("#f87171")}><div style={{...S.statVal("#f87171"),fontSize:20}}>{logisticsItems.filter(i=>!i.paid).length}</div><div style={S.statLbl}>Unpaid</div></div>
          <div style={S.statCard("#facc15")}><div style={{...S.statVal("#facc15"),fontSize:16}}>{fmt(logisticsItems.reduce((s,i)=>s+i.price,0))}</div><div style={S.statLbl}>Total Value</div></div>
        </div>

        {/* ── Map Panel ── */}
        <div style={{background:"#111520", border:"1px solid #2a3055", borderRadius:12, overflow:"hidden", marginBottom:16}}>
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", borderBottom:"1px solid #2a3055", flexWrap:"wrap", gap:8}}>
            <div style={{display:"flex", alignItems:"center", gap:8}}>
              <span style={{fontSize:16}}>🗺️</span>
              <span style={{fontWeight:700, color:"#edf2fc"}}>Equipment Locations</span>
              <span style={{background:"#c9a22720", color:"#d4a817", border:"1px solid #b4530950", borderRadius:10, padding:"1px 8px", fontSize:11, fontWeight:600}}>{withLocation.length} pins</span>
            </div>
            <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
              <a href={googleMapsUrl} target="_blank" rel="noopener noreferrer"
                style={{display:"flex", alignItems:"center", gap:5, background:"#1a3060", border:"1px solid #2d5090", borderRadius:7, color:"#6abf4a", padding:"6px 12px", fontSize:12, fontWeight:700, textDecoration:"none", opacity:withLocation.length===0?0.4:1, pointerEvents:withLocation.length===0?"none":"auto"}}>
                📍 Google Maps
              </a>
            </div>
          </div>

          {withLocation.length === 0 ? (
            <div style={{padding:"32px 20px", textAlign:"center", color:"#2a3a5a"}}>
              <div style={{fontSize:32, marginBottom:8}}>📍</div>
              <div style={{fontWeight:600, color:"#3a4a2a", marginBottom:4}}>No locations yet</div>
              <div style={{fontSize:12}}>Add a City, State to any equipment to see it pinned here.</div>
            </div>
          ) : (
            <div>
              <iframe
                title="Logistics Map"
                src={logisticsMapHtml ? undefined : undefined}
                srcDoc={logisticsMapHtml || undefined}
                style={{width:"100%", height:320, border:"none", display:"block"}}
              />
              {/* Pin rows — one per location with Maps + Earth links */}
              <div style={{padding:"10px 14px", borderTop:"1px solid #2a3055", display:"flex", flexDirection:"column", gap:8}}>
                {withLocation.map((item, idx) => (
                  <div key={item.id} style={{display:"flex", alignItems:"center", gap:8, flexWrap:"wrap"}}>
                    {/* Number badge */}
                    <div style={{background:item.readyForPickup?"#22c55e":"#ef4444", color:"#fff", borderRadius:"50%", width:22, height:22, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:800, flexShrink:0}}>
                      {idx+1}
                    </div>
                    {/* Equipment + location label */}
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{color:"#dde4f0", fontWeight:700, fontSize:13}}>{item.make} {item.model}{item.year ? ` (${item.year})` : ""}</div>
                      <div style={{color:"#8a9aba", fontSize:12}}>📍 {item.location}</div>
                    </div>
                    {/* Maps link */}
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location)}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{display:"inline-flex", alignItems:"center", gap:4, background:"#1a3060", border:"1px solid #2d5090", borderRadius:6, color:"#6abf4a", padding:"5px 10px", fontSize:11, fontWeight:700, textDecoration:"none", flexShrink:0}}>
                      📍 Maps
                    </a>

                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Equipment Cards ── */}
        {logisticsItems.length === 0 ? (
          <div style={{...S.card, textAlign:"center", color:"#4a5a7a", padding:"40px 20px"}}>
            <div style={{fontSize:36, marginBottom:10}}>🚛</div>
            <div style={{fontWeight:600, marginBottom:4}}>No equipment in logistics</div>
            <div style={{fontSize:13}}>Tap "+ Add" to log equipment you've purchased.</div>
          </div>
        ) : (
          logisticsItems.map((item, idx) => {
            const isPaid = item.paid;
            const isReady = item.readyForPickup;
            const borderColor = isReady ? "#166534" : isPaid ? "#1e4020" : "#2a3050";
            const bgColor = isReady ? "#111520" : isPaid ? "#1a2040" : "#1e2436";
            return (
              <div key={item.id} style={{background:bgColor, border:`2px solid ${borderColor}`, borderRadius:12, marginBottom:12, padding:16, transition:"all 0.2s"}}>

                {/* Top row: number badge + name + remove */}
                <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12}}>
                  <div style={{display:"flex", alignItems:"center", gap:10}}>
                    <div style={{background:isReady?"#22c55e":"#ef4444", color:"#fff", borderRadius:"50%", width:26, height:26, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, flexShrink:0}}>
                      {idx+1}
                    </div>
                    <div>
                      <div style={{fontWeight:800, color:"#edf2fc", fontSize:15}}>{item.year} {item.make} {item.model}</div>
                      <div style={{fontSize:12, color:"#4a5a7a"}}>{item.equipType}{item.serialNumber ? ` · S/N: ${item.serialNumber}` : ""}{item.hours ? ` · ${fmtNum(item.hours)} hrs` : ""}</div>
                    </div>
                  </div>
                  <div style={{display:"flex", gap:6}}>
                    <button onClick={()=>startEditLogItem(item)}
                      style={{background:"none", border:"1px solid #c9a22760", borderRadius:6, color:"#c9a227", fontSize:12, cursor:"pointer", padding:"4px 10px", fontWeight:600, touchAction:"manipulation"}}>
                      ✏️ Edit
                    </button>
                    <button onClick={()=>deleteLogisticsItem(item.id)}
                      style={{background:"none", border:"1px solid #7f1d1d60", borderRadius:6, color:"#f87171", fontSize:12, cursor:"pointer", padding:"4px 10px", fontWeight:600, touchAction:"manipulation"}}>
                      🗑
                    </button>
                  </div>
                </div>

                {/* Info grid */}
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:14, fontSize:13}}>
                  <div><span style={{color:"#4a5a7a", fontSize:11}}>DEALER</span><div style={{color:"#dde4f0", marginTop:2}}>{item.dealerName || "—"}</div></div>
                  <div><span style={{color:"#4a5a7a", fontSize:11}}>PRICE</span><div style={{color:"#d4a817", fontWeight:800, fontSize:16, marginTop:2}}>{fmt(item.price)}</div></div>
                  <div><span style={{color:"#4a5a7a", fontSize:11}}>LOCATION</span>
                    <div style={{marginTop:2}}>
                      {item.location
                        ? <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.location)}`} target="_blank" rel="noopener noreferrer" style={{color:"#6abf4a", textDecoration:"none", fontWeight:600}}>📍 {item.location}</a>
                        : <span style={{color:"#2a3a5a"}}>—</span>
                      }
                    </div>
                  </div>
                  <div><span style={{color:"#4a5a7a", fontSize:11}}>ADDED</span><div style={{color:"#8a9aba", marginTop:2}}>{item.dateAdded}</div></div>
                </div>

                {item.notes && <div style={{background:"#111520", borderRadius:6, padding:"6px 10px", color:"#7a8aaa", fontSize:12, marginBottom:12}}>📋 {item.notes}</div>}

                {/* Action buttons */}
                <div style={{display:"flex", flexDirection:"column", gap:8, marginTop:4}}>

                  {/* Row 1: Paid + Pickup Ready */}
                  <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8}}>

                    {/* Paid */}
                    <button
                      onClick={()=>togglePaid(item.id)}
                      style={{padding:"12px 8px", borderRadius:8, border:`2px solid ${isPaid?"#22c55e":"#374060"}`, background:isPaid?"#14530a":"#1e2a48", color:isPaid?"#4ade80":"#9aaac0", fontWeight:700, fontSize:13, cursor:"pointer", textAlign:"center", transition:"all 0.2s"}}>
                      {isPaid ? "✓ Paid" : "Mark Paid"}
                    </button>

                    {/* Ready for Pickup */}
                    <button
                      onClick={()=>toggleReadyForPickup(item.id)}
                      style={{padding:"12px 8px", borderRadius:8, border:`2px solid ${isReady?"#22c55e":"#374060"}`, background:isReady?"#14530a":"#1e2a48", color:isReady?"#4ade80":"#9aaac0", fontWeight:700, fontSize:13, cursor:"pointer", textAlign:"center", transition:"all 0.2s"}}>
                      {isReady ? "✓ Pickup Ready" : "Pickup Ready"}
                    </button>

                  </div>

                  {/* Row 2: Move to Inventory — full width, always visible */}
                  <button
                    onClick={()=>moveToInventory(item.id)}
                    style={{
                      padding:"14px 8px",
                      borderRadius:8,
                      border:`2px solid ${isPaid?"#c9a227":"#374060"}`,
                      background:isPaid?"#c9a227":"#1e2a48",
                      color:isPaid?"#fff":"#4a5a70",
                      fontWeight:800,
                      fontSize:14,
                      cursor:"pointer",
                      textAlign:"center",
                      transition:"all 0.2s",
                      opacity: isPaid ? 1 : 0.5,
                      letterSpacing:"0.02em",
                    }}>
                    {isPaid ? "📦  Move to Inventory  →" : "🔒  Move to Inventory (Mark Paid First)"}
                  </button>

                </div>
              </div>
            );
          })
        )}
      </div>
    );
  };


  // ── Invoice View ──
  const renderInvoice = () => {
    const invoiceEq = equipment.find(e => e.id === invoiceSelectedId) || null;
    const totals = invoiceEq ? getTotals(invoiceEq) : null;
    const taxAmt = parseFloat(invoiceTax) || 0;
    const freightAmt = parseFloat(invoiceFreight) || 0;
    const salePrice = invoiceEq?.salePrice || 0;
    const tradeAmt = totals?.tradeAllowance || 0;
    const subtotalAfterTrade = salePrice - tradeAmt;
    const grandTotal = subtotalAfterTrade + taxAmt + freightAmt;
    const LOGO_SRC = "data:image/webp;base64,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";

    return (
      <div>
        <h2 style={{margin:"0 0 4px", fontSize:22, fontWeight:800, color:"#ecf0fc"}}>Generate Invoice</h2>
        <p style={{margin:"0 0 20px", color:"#6a7a9a", fontSize:13}}>Select a PO, add optional tax and freight, then review the invoice.</p>

        <div style={{...S.card, marginBottom:20}}>
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:14}}>
            <div style={{gridColumn:"1 / -1"}}>
              <label style={{...S.label, marginBottom:6}}>PO Number</label>
              <select style={{...S.input, fontSize:14, appearance:"none"}} value={invoiceSelectedId}
                onChange={e=>{ setInvoiceSelectedId(e.target.value); setInvoiceTax(""); setInvoiceFreight(""); }}>
                <option value="">— Select PO —</option>
                {[...equipment].sort((a,b)=>a.poNumber.localeCompare(b.poNumber)).map(e=>(
                  <option key={e.id} value={e.id}>{e.poNumber} — {e.year} {e.make} {e.model}{e.status==="Sold"?" ✓":""}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{...S.label, marginBottom:6}}>Tax ($)</label>
              <input style={S.input} type="number" inputMode="decimal" placeholder="0.00"
                value={invoiceTax} onChange={e=>setInvoiceTax(e.target.value)} />
            </div>
            <div>
              <label style={{...S.label, marginBottom:6}}>Freight ($)</label>
              <input style={S.input} type="number" inputMode="decimal" placeholder="0.00"
                value={invoiceFreight} onChange={e=>setInvoiceFreight(e.target.value)} />
            </div>
            <div style={{display:"flex", alignItems:"flex-end"}}>
              <button style={{...S.btn("ghost"), width:"100%", fontSize:12}}
                onClick={()=>{setInvoiceTax(""); setInvoiceFreight("");}}>
                Clear
              </button>
            </div>
          </div>
        </div>

        {!invoiceEq ? (
          <div style={{...S.card, textAlign:"center", padding:"50px 20px", color:"#3a4a7a"}}>
            <div style={{fontSize:40, marginBottom:12}}>🧾</div>
            <div style={{fontWeight:600, color:"#6a7a9a", marginBottom:4}}>No PO selected</div>
            <div style={{fontSize:13}}>Choose a PO above to generate an invoice.</div>
          </div>
        ) : (
          <div style={{background:"#ffffff", borderRadius:14, overflow:"hidden", maxWidth:720, margin:"0 auto",
            color:"#1a1a2e", fontFamily:"'Inter',system-ui,sans-serif", boxShadow:"0 4px 32px #0004"}}>

            {/* Header */}
            <div style={{background:"#1c1f2e", padding:"28px 36px 20px", display:"flex", justifyContent:"space-between",
              alignItems:"flex-start", flexWrap:"wrap", gap:16}}>
              <img src={LOGO_SRC} alt="Red River Tractor & Equipment"
                style={{height:58, width:"auto", objectFit:"contain"}} />
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:26, fontWeight:900, color:"#c9a227", letterSpacing:"0.06em"}}>INVOICE</div>
                <div style={{fontFamily:"monospace", fontSize:15, color:"#d4a817", marginTop:3, fontWeight:700}}>
                  {invoiceEq.poNumber}</div>
                <div style={{color:"#6a7a9a", fontSize:12, marginTop:3}}>
                  {new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}</div>
              </div>
            </div>

            {/* Bill To + Unit */}
            <div style={{padding:"22px 36px", borderBottom:"2px solid #eef0f8",
              display:"grid", gridTemplateColumns:"1fr 1fr", gap:24}}>
              <div>
                <div style={{fontSize:10, textTransform:"uppercase", letterSpacing:"0.12em",
                  fontWeight:700, color:"#9a9ab8", marginBottom:8}}>Bill To</div>
                <div style={{fontSize:17, fontWeight:800, color:"#1a1a2e"}}>
                  {invoiceEq.soldTo || <span style={{color:"#aaa"}}>—</span>}</div>
                {invoiceEq.saleDate && <div style={{color:"#6a6a8a",fontSize:12,marginTop:4}}>
                  Sale Date: {invoiceEq.saleDate}</div>}
              </div>
              <div>
                <div style={{fontSize:10, textTransform:"uppercase", letterSpacing:"0.12em",
                  fontWeight:700, color:"#9a9ab8", marginBottom:8}}>Equipment</div>
                <div style={{fontSize:15, fontWeight:800, color:"#1a1a2e"}}>
                  {invoiceEq.year} {invoiceEq.make} {invoiceEq.model}</div>
                <div style={{color:"#6a6a8a", fontSize:12, marginTop:6,
                  display:"grid", gridTemplateColumns:"1fr 1fr", gap:"3px 12px"}}>
                  {invoiceEq.serialNumber && <span>S/N: <b>{invoiceEq.serialNumber}</b></span>}
                  {invoiceEq.hours && <span>Hrs: <b>{fmtNum(invoiceEq.hours)}</b></span>}
                  <span>Type: <b>{invoiceEq.equipType}</b></span>
                </div>
              </div>
            </div>

            {/* Line Items */}
            <div style={{padding:"22px 36px"}}>
              <div style={{display:"grid", gridTemplateColumns:"1fr 130px", gap:8,
                padding:"6px 0", borderBottom:"2px solid #1c1f2e", marginBottom:2}}>
                <span style={{fontSize:10,fontWeight:700,textTransform:"uppercase",
                  letterSpacing:"0.08em",color:"#9a9ab8"}}>Description</span>
                <span style={{fontSize:10,fontWeight:700,textTransform:"uppercase",
                  letterSpacing:"0.08em",color:"#9a9ab8",textAlign:"right"}}>Amount</span>
              </div>

              {/* Sale Price */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 130px",gap:8,
                padding:"11px 0",borderBottom:"1px solid #eef0f8",alignItems:"center"}}>
                <div>
                  <div style={{fontWeight:600,color:"#1a1a2e",fontSize:14}}>
                    {invoiceEq.year} {invoiceEq.make} {invoiceEq.model}</div>
                  <div style={{color:"#8a8aaa",fontSize:12}}>Equipment Sale</div>
                </div>
                <div style={{fontWeight:700,fontSize:15,color:"#1a1a2e",textAlign:"right"}}>
                  {fmt(salePrice)}</div>
              </div>

              {/* Trade-In */}
              {tradeAmt > 0 && (
                <div style={{display:"grid",gridTemplateColumns:"1fr 130px",gap:8,
                  padding:"11px 0",borderBottom:"1px solid #eef0f8",alignItems:"center"}}>
                  <div>
                    <div style={{fontWeight:600,color:"#b45309",fontSize:14}}>Trade-In Allowance</div>
                    <div style={{color:"#8a8aaa",fontSize:12}}>
                      {invoiceEq.tradeInDescription || "Trade-in vehicle"}</div>
                  </div>
                  <div style={{fontWeight:700,fontSize:15,color:"#b45309",textAlign:"right"}}>
                    − {fmt(tradeAmt)}</div>
                </div>
              )}

              {/* Freight */}
              {freightAmt > 0 && (
                <div style={{display:"grid",gridTemplateColumns:"1fr 130px",gap:8,
                  padding:"11px 0",borderBottom:"1px solid #eef0f8",alignItems:"center"}}>
                  <div>
                    <div style={{fontWeight:600,color:"#1a1a2e",fontSize:14}}>Freight / Delivery</div>
                    <div style={{color:"#8a8aaa",fontSize:12}}>Transportation charges</div>
                  </div>
                  <div style={{fontWeight:700,fontSize:15,color:"#1a1a2e",textAlign:"right"}}>
                    {fmt(freightAmt)}</div>
                </div>
              )}

              {/* Tax */}
              {taxAmt > 0 && (
                <div style={{display:"grid",gridTemplateColumns:"1fr 130px",gap:8,
                  padding:"11px 0",borderBottom:"1px solid #eef0f8",alignItems:"center"}}>
                  <div>
                    <div style={{fontWeight:600,color:"#1a1a2e",fontSize:14}}>Sales Tax</div>
                  </div>
                  <div style={{fontWeight:700,fontSize:15,color:"#1a1a2e",textAlign:"right"}}>
                    {fmt(taxAmt)}</div>
                </div>
              )}

              {/* Summary */}
              <div style={{marginTop:16,background:"#f5f7fc",borderRadius:8,padding:"16px 20px"}}>
                {tradeAmt > 0 && <>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#6a6a8a",marginBottom:5}}>
                    <span>Sale Price</span><span>{fmt(salePrice)}</span>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#b45309",marginBottom:5}}>
                    <span>Trade-In Allowance</span><span>− {fmt(tradeAmt)}</span>
                  </div>
                </>}
                {freightAmt > 0 && (
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#6a6a8a",marginBottom:5}}>
                    <span>Freight</span><span>+ {fmt(freightAmt)}</span>
                  </div>
                )}
                {taxAmt > 0 && (
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#6a6a8a",marginBottom:5}}>
                    <span>Tax</span><span>+ {fmt(taxAmt)}</span>
                  </div>
                )}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                  borderTop:"2px solid #1c1f2e",paddingTop:12,marginTop:8}}>
                  <span style={{fontSize:16,fontWeight:800,color:"#1a1a2e"}}>TOTAL DUE</span>
                  <span style={{fontSize:32,fontWeight:900,color:"#c9a227",fontVariantNumeric:"tabular-nums"}}>
                    {fmt(grandTotal)}</span>
                </div>
              </div>

              {!invoiceEq.salePrice && (
                <div style={{marginTop:12,padding:"10px 14px",background:"#fffbea",
                  border:"1px solid #c9a227",borderRadius:7,color:"#7a6000",fontSize:12}}>
                  ⚠️ No sale price recorded yet. Mark this unit as sold to finalize the invoice.
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{background:"#1c1f2e",padding:"14px 36px",display:"flex",
              justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
              <div style={{fontSize:11,color:"#3a4a6a"}}>Red River Tractor &amp; Equipment</div>
              <div style={{fontFamily:"monospace",fontSize:11,color:"#5a6a8a"}}>
                {invoiceEq.poNumber} · {new Date().toLocaleDateString()}</div>
            </div>
          </div>
        )}
      </div>
    );
  };


  // ── Admin View ──
  const renderAdmin = () => {
    const ADMIN_PIN = "1234"; // Change this PIN as needed

    const handlePinKey = (digit) => {
      if (adminPinError) { setAdminPinInput(""); setAdminPinError(false); }
      const next = adminPinInput + digit;
      setAdminPinInput(next);
      if (next.length === 4) {
        if (next === ADMIN_PIN) {
          setAdminUnlocked(true);
          setAdminPinInput("");
          setAdminPinError(false);
        } else {
          setAdminPinError(true);
          setTimeout(() => { setAdminPinInput(""); setAdminPinError(false); }, 900);
        }
      }
    };

    const handlePinBackspace = () => {
      setAdminPinInput(p => p.slice(0, -1));
      setAdminPinError(false);
    };

    const startEdit = (eq) => {
      setAdminEditId(eq.id);
      setAdminEditData({ ...eq });
    };

    const saveEdit = () => {
      updEq(adminEditId, () => ({ ...adminEditData }));
      setAdminEditId(null);
      setAdminEditData({});
    };

    const cancelEdit = () => {
      setAdminEditId(null);
      setAdminEditData({});
    };

    // ── PIN Lock Screen ──
    if (!adminUnlocked) {
      return (
        <div style={{display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"60vh", gap:24}}>
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:48, marginBottom:8}}>🔒</div>
            <h2 style={{margin:"0 0 4px", fontSize:22, fontWeight:800, color:"#edf2fc"}}>Admin Access</h2>
            <p style={{margin:0, color:"#7a8aaa", fontSize:13}}>Enter your 4-digit PIN to continue</p>
          </div>

          {/* PIN dots */}
          <div style={{display:"flex", gap:16}}>
            {[0,1,2,3].map(i => (
              <div key={i} style={{width:18, height:18, borderRadius:"50%",
                background: adminPinError ? "#f87171" : adminPinInput.length > i ? "#c9a227" : "transparent",
                border: `2px solid ${adminPinError ? "#f87171" : "#c9a227"}`,
                transition:"all 0.15s"}} />
            ))}
          </div>

          {/* Keypad */}
          <div style={{display:"grid", gridTemplateColumns:"repeat(3,72px)", gap:12}}>
            {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k, i) => (
              k === "" ? <div key={i} /> :
              <button key={i}
                onClick={() => k === "⌫" ? handlePinBackspace() : handlePinKey(String(k))}
                style={{height:64, borderRadius:12,
                  background: k === "⌫" ? "transparent" : "#1e2235",
                  border: k === "⌫" ? "none" : "1px solid #2a3055",
                  color: adminPinError ? "#f87171" : "#edf2fc",
                  fontSize: k === "⌫" ? 22 : 24, fontWeight:700, cursor:"pointer",
                  touchAction:"manipulation"}}>
                {k}
              </button>
            ))}
          </div>

          {adminPinError && (
            <div style={{color:"#f87171", fontSize:13, fontWeight:600}}>Incorrect PIN — try again</div>
          )}
        </div>
      );
    }

    // ── Admin Panel ──
    const editingEq = adminEditId ? equipment.find(e => e.id === adminEditId) : null;

    return (
      <div>
        {/* Header */}
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20}}>
          <div>
            <h2 style={{margin:0, fontSize:22, fontWeight:800, color:"#edf2fc"}}>⚙️ Admin Panel</h2>
            <p style={{margin:"4px 0 0", color:"#7a8aaa", fontSize:13}}>Full edit access — all fields on all units</p>
          </div>
          <button style={{...S.btn("danger"), fontSize:12}}
            onClick={() => { setAdminUnlocked(false); setAdminEditId(null); setView("dashboard"); }}>
            🔒 Lock &amp; Exit
          </button>
        </div>

        {/* Edit modal */}
        {adminEditId && adminEditData && (
          <div style={S.modal} onClick={cancelEdit}>
            <div style={{...S.modalCard, maxWidth:620}} onClick={e=>e.stopPropagation()}>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16}}>
                <h3 style={{margin:0, color:"#edf2fc", fontSize:16}}>Edit {adminEditData.poNumber}</h3>
                <button onClick={cancelEdit} style={{background:"none",border:"none",color:"#7a8aaa",fontSize:20,cursor:"pointer"}}>✕</button>
              </div>

              <div style={{display:"flex", flexDirection:"column", gap:12}}>
                {/* PO Number */}
                <div>
                  <label style={S.label}>PO Number</label>
                  <input style={S.input} value={adminEditData.poNumber||""} autoComplete="off" autoCorrect="off" spellCheck="false"
                    onChange={e=>setAdminEditData(p=>({...p,poNumber:e.target.value}))} />
                </div>

                <div style={S.grid3}>
                  <div><label style={S.label}>Year</label>
                    <input style={S.input} value={adminEditData.year||""} autoComplete="off"
                      onChange={e=>setAdminEditData(p=>({...p,year:e.target.value}))} /></div>
                  <div><label style={S.label}>Make</label>
                    <input style={S.input} value={adminEditData.make||""} autoComplete="off" autoCorrect="off" spellCheck="false"
                      onChange={e=>setAdminEditData(p=>({...p,make:e.target.value}))} /></div>
                  <div><label style={S.label}>Model</label>
                    <input style={S.input} value={adminEditData.model||""} autoComplete="off" autoCorrect="off" spellCheck="false"
                      onChange={e=>setAdminEditData(p=>({...p,model:e.target.value}))} /></div>
                </div>

                <div style={S.grid2}>
                  <div><label style={S.label}>Serial Number</label>
                    <input style={S.input} value={adminEditData.serialNumber||""} autoComplete="off" autoCorrect="off" spellCheck="false"
                      onChange={e=>setAdminEditData(p=>({...p,serialNumber:e.target.value}))} /></div>
                  <div><label style={S.label}>Hours</label>
                    <input style={S.input} type="number" inputMode="numeric" value={adminEditData.hours||""}
                      onChange={e=>setAdminEditData(p=>({...p,hours:e.target.value}))} /></div>
                </div>

                <div style={S.grid2}>
                  <div><label style={S.label}>Purchase Price ($)</label>
                    <input style={S.input} type="number" inputMode="decimal" value={adminEditData.purchasePrice||""}
                      onChange={e=>setAdminEditData(p=>({...p,purchasePrice:parseFloat(e.target.value)||0}))} /></div>
                  <div><label style={S.label}>Purchased From</label>
                    <input style={S.input} value={adminEditData.purchaseFrom||""} autoComplete="off" autoCorrect="off" spellCheck="false"
                      onChange={e=>setAdminEditData(p=>({...p,purchaseFrom:e.target.value}))} /></div>
                </div>

                <div style={S.grid2}>
                  <div><label style={S.label}>Check Number</label>
                    <input style={S.input} value={adminEditData.checkNumber||""} autoComplete="off" inputMode="numeric"
                      onChange={e=>setAdminEditData(p=>({...p,checkNumber:e.target.value}))} /></div>
                  <div /></div>

                <div style={S.grid2}>
                  <div><label style={S.label}>Sale Price ($)</label>
                    <input style={S.input} type="number" inputMode="decimal" value={adminEditData.salePrice||""}
                      onChange={e=>setAdminEditData(p=>({...p,salePrice:parseFloat(e.target.value)||null}))} /></div>
                  <div><label style={S.label}>Sold To</label>
                    <input style={S.input} value={adminEditData.soldTo||""} autoComplete="off" autoCorrect="off" spellCheck="false"
                      onChange={e=>setAdminEditData(p=>({...p,soldTo:e.target.value}))} /></div>
                </div>

                <div style={S.grid2}>
                  <div><label style={S.label}>Sale Date</label>
                    <input style={S.input} type="date" value={adminEditData.saleDate||""}
                      onChange={e=>setAdminEditData(p=>({...p,saleDate:e.target.value}))} /></div>
                  <div><label style={S.label}>Status</label>
                    <select style={{...S.input, appearance:"none"}} value={adminEditData.status||"Active"}
                      onChange={e=>setAdminEditData(p=>({...p,status:e.target.value}))}>
                      <option>Active</option>
                      <option>Sold</option>
                      <option>Trade-In</option>
                    </select></div>
                </div>

                <div style={S.grid2}>
                  <div><label style={S.label}>Trade Allowance ($)</label>
                    <input style={S.input} type="number" inputMode="decimal" value={adminEditData.tradeAllowance||""}
                      onChange={e=>setAdminEditData(p=>({...p,tradeAllowance:parseFloat(e.target.value)||null}))} /></div>
                  <div><label style={S.label}>Trade-In Description</label>
                    <input style={S.input} value={adminEditData.tradeInDescription||""} autoComplete="off" autoCorrect="off" spellCheck="false"
                      onChange={e=>setAdminEditData(p=>({...p,tradeInDescription:e.target.value}))} /></div>
                </div>

                <div><label style={S.label}>Equipment Type</label>
                  <select style={{...S.input, appearance:"none"}} value={adminEditData.equipType||"Farm"}
                    onChange={e=>setAdminEditData(p=>({...p,equipType:e.target.value}))}>
                    {["Farm","Construction","Truck","Attachment","Other"].map(o=><option key={o}>{o}</option>)}
                  </select></div>

                <div><label style={S.label}>Notes</label>
                  <textarea style={{...S.input, height:60, resize:"none"}} value={adminEditData.notes||""}
                    onChange={e=>setAdminEditData(p=>({...p,notes:e.target.value}))} /></div>
              </div>

              <div style={{display:"flex", gap:8, marginTop:20}}>
                <button style={{...S.btn("ghost"), flex:1}} onClick={cancelEdit}>Cancel</button>
                <button style={{...S.btn("danger"), flex:1}} onClick={() => { deleteEquipment(adminEditId); setAdminEditId(null); }}>Delete PO</button>
                <button style={{...S.btn("primary"), flex:2}} onClick={saveEdit}>Save Changes</button>
              </div>
            </div>
          </div>
        )}

        {/* Equipment list */}
        <div style={{marginBottom:8, display:"flex", gap:8, alignItems:"center"}}>
          <span style={{...S.secTitle, marginBottom:0}}>{equipment.length} units in system</span>
          <span style={{fontSize:12, color:"#4a5a7a"}}>Tap any row to edit everything</span>
        </div>

        {equipment.length === 0 ? (
          <div style={{...S.card, textAlign:"center", padding:"40px 20px", color:"#4a5a7a"}}>
            No equipment in system yet.
          </div>
        ) : (
          equipment.map((eq) => {
            const { totalIn } = getTotals(eq);
            return (
              <div key={eq.id}
                onClick={() => startEdit(eq)}
                style={{background:"#1e2235", border:"1px solid #2a3055", borderRadius:10,
                  marginBottom:8, padding:"12px 16px", cursor:"pointer",
                  display:"flex", alignItems:"center", gap:12, flexWrap:"wrap",
                  touchAction:"manipulation"}}>
                <span style={S.poTag}>{eq.poNumber}</span>
                <div style={{flex:1, minWidth:160}}>
                  <div style={{fontWeight:700, color:"#edf2fc", fontSize:14}}>
                    {eq.year} {eq.make} {eq.model}</div>
                  <div style={{fontSize:11, color:"#4a5a7a"}}>
                    S/N: {eq.serialNumber||"—"} · {fmtNum(eq.hours)} hrs</div>
                </div>
                <span style={S.badge(eq.status)}>{eq.status}</span>
                <div style={{textAlign:"right"}}>
                  <div style={{color:"#d4a817", fontWeight:700, fontSize:13}}>{fmt(totalIn)}</div>
                  <div style={{fontSize:10, color:"#4a5a7a"}}>cost in</div>
                </div>
                {eq.salePrice && (
                  <div style={{textAlign:"right"}}>
                    <div style={{color:"#4ade80", fontWeight:700, fontSize:13}}>{fmt(eq.salePrice)}</div>
                    <div style={{fontSize:10, color:"#4a5a7a"}}>sale</div>
                  </div>
                )}
                <div style={{color:"#c9a227", fontSize:13}}>✏️</div>
              </div>
            );
          })
        )}
      </div>
    );
  };

  return (
    <div style={S.app}>
      <style>{`
        * { -webkit-tap-highlight-color: transparent; }
        button, a, [role="button"] { touch-action: manipulation; }
        input, select, textarea { font-size: 16px !important; }
      `}</style>
      {/* Loading screen */}
      {!storageLoaded && (
        <div style={{position:"fixed",inset:0,background:"#1c1f2e",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:999,gap:20}}>
          <img src="data:image/webp;base64,UklGRqhtAABXRUJQVlA4WAoAAAAQAAAAnwEA" alt="Red River" style={{height:60,opacity:0.8}} />
          <div style={{display:"flex",alignItems:"center",gap:10,color:"#8a9aba"}}>
            <div style={{width:18,height:18,border:"2px solid #c9a227",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.8s linear infinite"}} />
            <span style={{fontSize:15}}>Loading Red River data…</span>
          </div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}
      {/* App PIN Lock Screen */}
      {storageLoaded && !appUnlocked && (
        <div style={{position:"fixed",inset:0,background:"#1c1f2e",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:500,gap:24,padding:20}}>
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:44,marginBottom:10}}>🔒</div>
            <div style={{fontSize:24,fontWeight:900,color:"#edf2fc",marginBottom:4}}>RRTE Inventory</div>
            <div style={{fontSize:14,color:"#7a8aaa"}}>Red River Tractor &amp; Equipment</div>
            <div style={{fontSize:13,color:"#6a7a9a",marginTop:8}}>Enter your PIN to continue</div>
          </div>

          {/* PIN dots */}
          <div style={{display:"flex",gap:14}}>
            {[0,1,2,3].map(i=>(
              <div key={i} style={{
                width:20,height:20,borderRadius:"50%",
                background: appPinError ? "#f87171" : appPinInput.length > i ? "#c9a227" : "transparent",
                border:`2px solid ${appPinError?"#f87171":"#c9a227"}`,
                transition:"all 0.15s",
                transform: appPinShake ? "translateX(0)" : "none"
              }}/>
            ))}
          </div>

          {appPinError && (
            <div style={{color:"#f87171",fontSize:13,fontWeight:600,marginTop:-12}}>
              Incorrect PIN — try again
            </div>
          )}

          {/* Keypad */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,80px)",gap:12}}>
            {[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k,i)=>(
              k==="" ? <div key={i}/> :
              <button key={i}
                onClick={()=>{
                  if(k==="⌫"){
                    setAppPinInput(p=>p.slice(0,-1));
                    setAppPinError(false);
                    return;
                  }
                  if(appPinError){ setAppPinInput(""); setAppPinError(false); }
                  const next = appPinInput + String(k);
                  setAppPinInput(next);
                  if(next.length===4){
                    if(next==="1234"){
                      setAppUnlocked(true);
                      setAppPinInput("");
                      setAppPinError(false);
                    } else {
                      setAppPinError(true);
                      setAppPinShake(true);
                      setTimeout(()=>{ setAppPinInput(""); setAppPinError(false); setAppPinShake(false); },900);
                    }
                  }
                }}
                style={{
                  height:72,borderRadius:14,
                  background: k==="⌫" ? "transparent" : "#1e2235",
                  border: k==="⌫" ? "none" : "1px solid #2a3055",
                  color: appPinError ? "#f87171" : "#edf2fc",
                  fontSize: k==="⌫" ? 24 : 26,
                  fontWeight:700,cursor:"pointer",
                  touchAction:"manipulation",
                  WebkitTapHighlightColor:"transparent",
                  boxShadow: k!=="⌫" ? "0 2px 8px #0003" : "none",
                }}>
                {k}
              </button>
            ))}
          </div>

          <div style={{fontSize:11,color:"#3a4a6a",marginTop:8}}>
            Powered by IronLedger
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{...S.header, height:70}}>
        <div style={{...S.logoWrap}}>
          <img src="data:image/webp;base64,UklGRqhtAABXRUJQVlA4WAoAAAAQAAAAnwEAawAAQUxQSBs9AAAN4IZtuyK3lahnrapqbqnFYLFlW5bMzInjJHZw856Zw8zM9O/8YmbmM2dzdsCJ45gZZZYsW7IsZqm5u6rW+tGtrpbHe2b/jIgJ4G+06P3FsVrlsoZC4lz+/27xZ/vmI/6sFmIt0MgNvrOzf66z9rYBQq4JyMbty/cyf6aLbs3wRsa2P1z6M11TBW9mdP3EXPmEZUntQTmO8iADhi6LdnLFzEBJruOqtTJ8pvYgXNtVHoyA4eYcwPCZ2NnyCJ8l3LwD0meWyc3qItJveHJs90+Fb1OywLF1GUQRDZYF/i57xC1b+GBfICtKkSI9MfcynlclGD0HqxztTUs9dnPKBcJ7dhhaF5NqaX7p9bJju2tgdh6qd1VJUq68Xp6eyZYS6DlUtfToXgraj62To9dGVTkaD2xk+cmjhO7e26xdhCeD+SdPMxqM7sPV2KKYBiGYfz07nnH+JFQWcW/3ZyzpSRcRtl7/TgVUtU/Mla3hg7q8qUvRmGG/MdD/1Fmt8dg6R+BdIAILX08C2w77XUQxLfx+v4wvPOtPlS+4Z4uJKEmrQMTne3RmejXR/k7M9vseXsjQ8knArsx+Oay8yWO7HSdkX7/jvrsvqyXakxaByIXrGag53p3CUMUEaC0CETNx++7Sn4LaRoC5swMYulxaVX3aZSD75qbLFqkHi9IDtdVdzdmnlxKrrQNTeAPR1H33NdBVB4JVRbQq2tYayL64NVI2s9aPWRqEGqK1m+fPDazW0A7RLerOCulQ2KjbN3Un6a22F4xg9askHQGkoJyVm5YfJ6G2DZCiWPFYQ90m3+iV4befbHcBPZCFrLfiGl6muyPI9SuzZbNTMcrZcmTj4+8TxUTWNCizEApwcyG8isp9hzOXHqTKpFNEKOe6XxjnHttFULZPkA4BI4+PxojseD7rbYMGuKERcVVJ2aVCiJxFOeWBd/TFu/m3XbRpDsj017GmiWcbqhCtoeeqXLgG2JNz0iimrUgwFDTkjg8nfpcqooQAliZdQ+jSAirRBaCQYM/NaAOUGQwGgwFBy4ndN75ZLpMA9PJ0wpKrGNHKiEn0xxu/v+oWwZUCpQ1YeNa5jsDehUHXS2BLEph8biE0QHo2qU2tS5JWIhYDcA1gaTxrylWsykjIouH9LV9fedtVNqaB+CtjbfLP6hsFgfbFuXIpCSz/9ROhhC4QmljT1m0xet6f/TJToCm4+fuUxqMjuiMFWmjB/MWLaLRUOljTvH5LDP+W96a/XC5LUaf/9ILSupgwGvbsr8B/ou37EVWgQaC1AJ4ktoVobxye89K2SQM3DVFMjfz+FZ5d/zoD0AJQN75OoAENQlut6/c1EdrbdnX4LVdXrYCpPGvrTtBkIVr1WLlQEjJPHFdrijrJmZXM5lMhNh+69qyg+OQzlPZCyblXcyhAZRcXkpnwwUOSDacmv0uWzZ1+iasp7iyPzW/6pBJxLHx9qaDkufvdXYjdC6OqNP/OFJB7WAVoBMw90zgelKLksSGcAkA789OJxlPN8B4X1FtNtpqAM1y5Riwu1lcgG+RE2dACI7pMqWr+0cTOzSabws8yBRoBgdAi5RYaMIJZh+KZmeH78a0fVNJ96sF1p1zCF1qi1Mzj610ngsT2Ppr25Nyt7IFd+QGntJrNOeBZViI0hWYo5VJmUSToX6bUpVd3Nx42aGwfm3yrVTRkgKXx2FrlRqoaEI2hEVW2QqlKAgbjPVGC7bOLRQQgUWVbVehVgNy1c7tOhsT2XdeflQuh8fjs3gf1WB2ZKdcLY+OdjdR2v5wrrb0aSN9oZHWJYm0lqiQYG+xtxteuRtTbrC6qgMUZY614GWiSVFfPJNbEu16JGpi1qUTBmmtRxKMeurh1r8Ep47QqVxmXQz6oiiykPamr4W0mfcYTt5TY1gVg5plZIAoQumwaQVlfyTYI+Zf1W0zUBgDGM6z5hNEEVo2zoN8kQ2mQITv3RqBFGeD20p5qItsmx9w3xW8DZjiX9cRgvseiN3Zdl9Lc7ID71OBvsp2LgCEc3uKyzgLyo5VrN203G4j64Jj7JuVCGrQjKRQFai3KbD+OtUvaqx++Ma4BuK6B9/hQ4zqiPa/mdQkdUWD+WaSIRoBAl00jylMRBI3gbW41usDCcnTt8uOxamRN5aj9JtVVpcFdChTTgJN/05iym03qGp/nyiTQHnyd00Aq7i8D9zO7/WxsvJVdraInD7ycEUWK2jblE5TV2pIG8rZ8m4XrFDCf8q0d43YnRGLTzhtUvS+tITdVVaSoPxK3yyZ0eZLZKoNo7eJKmbxv7nFATbuiHOOj2yPU776xtIqxMwTkHlVQqkLocpVZbo8BesHmbV4bBFjIiDdgIdMCoeqVRHk0Apy4B+tEnQbmRmURJQR694f2yKIpVxOmGhtwipV7Nt7mw/SpbHl00i3N2LdrGcgO1VHO7KB/vRXavDiyim+rBl7P+YsJQNRutLRfi1L8U4OJUnTSKS2yv2sJyA7532aiShexeWOi2ZVyIQj0GIYQRbSOdDQvuUD2YgNFpQa69tRFTU2J2szeuZorokV5MtmoiRlwM+WRTe05U2hACO1W7owsAYw+8JeF1/M9IdHa+Hy5WEUrQL8tihWKtvfWSZeSVWjkqzkNSA2I5o60JQAhBE5Vb2heAw9meZsbVTbgzgbfiGyjgVWl5stTtPLTjS7FNaZIu0DuwqQoVihkqLIh6qoSlGrNX14uUnYlBGbQyeqymFuOxgTFtTDjLsDMhUrKu/Cos53wodHnRYwtNjAz6KPkio4qXKFLqmi6OOGwqtx1PKQpqgVGwgUYuhZ4q1l1WWA+7UGK1bTWJaRTwQjU+2bz5QtsbEbrIhIFoHK3HklKd4UhKFEjsBy3iNDl0QhAoiirrO+ocbUAtJZCATgrX9mUOX8r2BeQuzJPdUH13jg4/ZriGgQghBaUrKWUeb0azRvDrga0RpsKwHn9fQ1/AuZyoiSjIQYatBDxaacENyuDEIrGM2VxhBQgBasLCid/eOWj9PgyQugSEIEstayplBq0LSizkILVBUD+3jcNolzMz9bViap1szMFHW1AdiC2CloA9lJaeDCC8WqTEoUUeMxfulrP292odkGvKEpt/mxrBi0AZHD018OrsexUGZiVqWw5jCiFtq0FoITfELD84OpSk8Tj3S8XDUmp2vb3+damsTIFTtosl8q7okBLvwRGbjwwKim/ulndbRj7cveAyr55YGxUrCI0oIe/GbF9uiSd74qJAiUE4NqOEIBr+SRkR270V0Z5y5uVgLskSwmc7AIEIMC3fvrC7Gpz6SYfVk0yWY5AnQMkrw7JAlx5uM8kd+Eu3keeKtstCYe1ro7kwckbZXJf3J/2Fyh33f4WGD6XYU3vZbeH6Y3dtqF2Ux4y92OsLjToqf48WUpWDiXrwZsrhgRhy03HfLivvuftH/YVLBilNB2g5LpDo/2rrSTqffga4ivlMCsKVr4aMLUAodM9H64j4s8lS1JCQIAsb7hf2JDL+ctkP7o+YxRobe14P0CNtWCXJLSXzKPaThHpSg8rmiuAqUFfKQCGz3ZYS7f/XMLUgMzVHN9iWjVqwX3biSpVkLRKCHQkS6NbvXZWcdJhA6MmlSoHCgkqh601hd8G3gmGf1T5v2dKKSpRb1qNT0FitqJMqCypAhgc2LBD7Dh497YuRQsvjKR6TNFR+cSOtS8C4wt4NYTDmgo7S1aBhnt3P+20et67dvttZ9UmATtbSrBx0UNNdCazSm65yoeocMqibWmCkC6rvr61aYtoOrh41fby5gd2LwELM/4yCemw+u2xd6s50Hd6spQyDr06GhAt3fdWNnUoWHlSU4IGAQi1RhKX4vFz4kitb3fDpYW3XKhtEsgl/SWEm7yItvTcavFoAMLmSjmyi1YdCNNejWtDH9Wz+di5ob9h8gOpgWdZWSYM3NWS1xq2SvM9+4q9FvaLhipRuWl2tKcKGByTJaAFgBZrgxSrkfx95xGCp/Kn1dvN37gMpNKUWFmV8kCjnNLFnKQ/CFZsySlDflHWA5oS0+cCh4PmcetywovQ5dOiHDu2ZYGFIUG5taDE4cf7G6j96NldvQYsPt8aprFyOgo4jxWlCl0g9BqV/vDl/maxfuejgbebFhJIqFKqgnkvVdaSXczO+AJghJ10GRB4n/7mYI8I/WjsigelWVutPWz7IAVwjfKVnrwS2u83DtXenFyLse9OdBLotuaAsUlKFRpAK/kG8cPsL0yxp+ebhbeaYeaBbEnVlvLSEJrIF3NSviDIkJ0ri/aWvzl1eB1be++8LM22yyeEBu2WYgW2vpMGmLvip+wCXQJDX29/RwZ/vHgxuwb5+6IvHDrU+gDc/lxJxR2bN3n8ZvsOs+HYwpX820wG8qCSvhJkROE1YibcYipBhcAIloky2r+rPS6t9yt/a5cUrkwbhgep4tkCCWBEgllfgXaqtm8L2wDLv2riDVW3XuzbIFqOPr+ny0eyv3Od2dOVhuV+WQZ/BY5PlybcdLpsPH70cSVd79588jbLVGjILwRL8bueLJFn1VldbSH9ebcciDLw6vHGjdQfXL6kiwgN9L0T0kKXZsipqy+AFTcmqdixS4oCpGlRNPVVkvJqBOjS4Jw4anKo9ezCGoirVZuFFQQ9nKR0CYiWY3VSejD0Yv9ACmRZUtfqtklxJHop+VYyhTSECtgu2MkgUgJCOxFfxpM/lkoaAtBapS0LWeVbMdAIlbdLEMW0B67NfG7Qd/j7kQJTKqDnWAxHlKS1iD65PAtLbrWkYuduv1MgLIrPfjsryiOkArTwMPVsfTuho/Zlu8A0XNCI0tTL5Z4oQPp+Q0laGgXrjrZIR5amzKD9bT9gABpRmnp1/VAnoY8Wz799ZMPGSmn4pLKGAKO50wwJEEJngtOOJ7Z35AxDC7QOPMyC2bNdmloJ4aSfvrRXwbAAKR0Pk/dbthM6VP/dAuAKAxCGQFCygOatr4YUYUsB0qBknX5xRlFuS4CJq0vj3PQnlaw/detBHnCED3za0SWhLwf3Fiw8omThCAMQUuK9Zv/SVXSSKEjD0SWR+059GBJbdt0YUm+brr+qySo3r42ZPBDY905NVgFK+peWtLeeTxsdBQiRjCuQbYc6bSHQRkieuewW03nhA5/IeeDJ7VONVP189Awwnms3KXdYZzQIgVdneejeiwrKbSdiEsNwXQ+L33Xsl8bhDVeea9TsYi/4hK1K40HqEKAeGaVpxnyNlDvgi8PiYpdEBHKqNBa+qPsM85P2/2/uLVPxkUlRQaGsqrMo7qOcgaYQiAKKWtEwSDB8W6svPy/G7KNYnUrX4TX+Q2prVLRuXFyGuQdGV94ti0/FWwQ8ftUWUgVag1C51NLkXL6K8mcep9b5kr5mvA5daF8v9Ak9pmD8QWWzTFTW4DF+O9Vj6ZmZSGlwZ7xPKC2KKGQRrUGKbBhI9y/1ypzViNent9pbZfSQ/Vq9XU7W8LY8Wf/VUrGVb4elXdHqSU1+NWc51nu1Duibl/OGLguioxqY+X5cC82qWrnCCrCW6tmFuDDWV3hyv3viatWx3QAydy4jzc1+L9z6XkjlXye8PL8yi6acQoseQPX/4OL2BDxx7awp7O5e8+1yuFe9NWKfZ88sF1Gjjxcsv/QEL5+uSBUwAZYejBtGWWxhCYCx21khACFAS58pWOP8ndF8wBSeyN4aQ0qfAFi+M+P6TTynnwznpQ/PzuBDLYUuIlFFhAAXnwEQf/xSBSy8xx+MKyfoE7xNOz/O8/Zc9/feOa8LIO9Q3ryLorhjU17NqjnNm+3amrI6NrgUt11NOXVOU06dZY3dPOV1bY3mrdryC5u3adenjy65Rf58HF34LqEM0AgNCIFw7cbtDeJN0Ev3RiMapQEBCK3NvdvS6s84wgIEGgHKLmJO/PqplAhNcSX8Ujtt7/cab4J6fua1VHklWVUop7ZWUtwn0CB0gXL+LCIa26Ig0FoihLM8uqDBXYnjk46WUrtSaPIq58JyqMZ8IyZs4iB8GrRAa2HoZYpHu+qFBo3QCG2Pj+X//GEefL8+o8HwkXO19gVff3ffRfuOHa7SaGGKPGDk7l+cBO0a4k0gGYDIRwcNpZCGcLQW5K9fWAHR9rNNKVcg/YbtKC0Cxg9/sP/sseWDrEYAM75GCYR3W9+9JHRiczKJYWmVj+QdoYK1qW9ekMuHjDdBZwyafxRL5MEwlLZwHfyNU79ZFi0fuhqBILnYGJHAuq6Ri86fOYydPsCZH74xa3x0BBChnfMDdB1zATJjT5O7N/vBatkxeSOdzFVYb0RCip17NBiS8eu53s5qU1idffee2y07NYB+fHq2ds/6xiByZ+W17J85gr4M+fjgsyHLiPR1SwDps936KnAyYw+eTYV3nGwCRLBxOp1JvxluwudvzFLoXPh2qbp9+5awadRUjWcMpUTByNPU89nWrX11QRFO6T9zGIHU4q0rixGj8oPtwxRVjsCHsp+eH66Qvs0sUei4Fnnbb74J+azpz7uBAqPGnDh/fbLuwP6KoHBcW1kSkDt3D93uv/DA3PXO+mBS/ZlDPLtz3xRG0yfv5myKa0CNvbiYiOA79kH9mF1EuwZu3nojMil8DrKAg79wrvxw+8pQ9nDPZj9aGRS2fLjPuvr9vcv98aZjEd7mQr8BQr8JQr9ZQpdD6NKEXkXoYkKvQfb2ecy+XZtU+tVQRb0oKHz55Sw0H9wVTrmaUld8wTch6yC0oFDE1m/rMO5eu3ZzsGJ7QKBFkaXl7nd3147cuXDmebNVkggE0UJrIUFn3Yh0tRDSzaaLWWGfA0JmMm4xMxoQubhtVuUy/hBCoxECnUwXyIqwdFdSBaIypB2EFLlk3kOwxlxZ1qUEKy1bCaNA5uK5AjMWMpxEXAFmZUBrqZfTwSrDEW7cH0YJI56NWa4Whs4nM+Cv8ruQjKsCIxp1pcjFw2GlkBownWWnMqCEvZRDxqLKNdy0DplKKBBC45ZhObZrb4cf/deno93buyN+QKBfPjRbd2xrZOUPg+s3NwYKtIBFt+5NyAEKCTjLzx7V/JN/sX3hxd0zD0GAAGfl1ZOBuUP/6nv79eyN+8OiJF93X8TVjpaGqd3h+b6Icg1T6Pjwy0RB/e4mG6ms4YeLBUZjb3PISo4+rt418aJ+i19rR0lTCHvgYRqrfkN7VLpLz4cXwdrXp/OYlranh8aypbTsbAvMPhjIr2Z07KvOKMM0ADd+/6WNbNrcEjPyK6+ezUHl0XXasfSF5xuOG9lAajDaKR3TPzi8vVY5piUyC8NDmbr3GnOuOX1tpqDpQL3Git9u7cu40pKg5fLTmZ0dOa2e3LF9h3bkHTM/nl0XQ9iOYRjKwbvo/axjyYa58YXcnbGWg7sjAb+y8XW+s9mf03xxkXTN4Z0VIWHgQtyJybVzkn6ENCCbeHZxQsjdH286vjMyfOlpVht+7JWhK0MhfHJDvW//wc1jZ667pQT2HY7EdViSyQXDAwMbWipcN+X66wJXzswXHOmJGK7rPL4yA/h3fNSkHDsUSy0ERh837gqkRVCKlB0Uw+dn/Ds/bnaVHVgXefD1qGPs21NpYKdERVPyzOXsKqL+81470+FevGqvIjv2tQSEm3HRPlPfvp307fqoWSkn1Bob+OOwHT28ISrc+KXHXSeqDbnwQndWmy4jz7q7QsLNONFm87vv9XtdQWXKc7cUsPe4awg7eTu6JSpFVmlMkR993La5yg4tnn5p7twdNtz4As0BWweltnN+M+TNv7udwuipLXcvXL/40t1zuDXkqM1/mXMBOqpGH128m9hxYHOFP+OSzYXNtcsnAhg+mXt5534eKntSaXyVvdubv7yblc7UvYtZi8je91JJMHzrdiXPZUsRNYEXXxg/7ct8eWfP522X/tB9smLoj69ju//FkzO/W4YXI3ubXwfWPZ6KAcHjx/K8uD4dOvzPdBF3I/ra+boft079cfLEe5HX8sMjMHR53tjzT31U+8cb6W8njxx0Tp/3N/3VX26+e94p5jsZs399+dR/sPPrp6vYTy/1fBS4d3HGn9v4WVduwXj/XZuhK9PhLX/18/VfXB47a31SP/5DH/0Xf7Fh+kJ02TzZuPJ9pvP++vfCz7953XHiHzjx/L/468ZP6+joGJyA6BYb4Vx51Dts/6Ru7tsBQ4c+fj9y7dfhn9byTt3vF795fWr3y9P1v2we/v+tv1yf+ubBO+/h3YzqIsG+D+vsG7fP3xxUbftN3biBogd/HH10/Y8P+9Pr+jbWgONYxtrZaT8sDL54GoDOAzvDeQBRt35mPD/3/YCGpiM7q22KVwTmVSnSp27csPbtmbw61Xai/tUPgV1t92+zIk9+tnNwQJMYWZf7Y+TnC1OA3LUX/cW5SFA66z+s04ZUZx5VHtj86HZ615G82PQ++bMXfAGdaP2n/6Lx3LPbd9efyHw7mbVbfv5+9c25YmYvz7+m4Zd7l144xRi9LD+OXXqYcQkf2JK3th1Hf3U+FHQX2//pH229dPnszN7eO3fg1Zk9u249wH29s3fkO8E9Djbev6Hj7t/38YFz/+3EB53Z0IHkY8V2S8PE3TEWhg71PLy5hE4f+Miaej64v5fK9ybu3bzed/Tm/cr3ffcvcmzX5PmJbcdC3tyU31+w8mL84D91IDN+7eKZiYAkl6ouout3bY/MX7199lxwZxjcdNBcOzdjkn/8dRJz8+GN2cWljEHhfNSvR7+GTbt7rKX7X1R31xXE8xFKzqWU4dOGq0mlAxHhSpW2cV4F10Wisy5yY+7BI/++PYtjEDpoq/4LgDt5OvBJNKRShiEMYWsjlROd+1Jcuwa4w99s+fhz/4UlpQ07BbOLdTVNyUQx50WsuT4azr8OmJRomyKRwamavrLSWXncUf0XgdzE+dZPPqo8u5IzzHwOMNL+vA2OtlQGyBmmslm+1dLb0Xo5E1h8seGQ/1mevSvxyY5QRiPyWJk0yue/OlRfhyOyI3VH9p2b0rYvp/1JIx8wtIlm0Qp7w9SgFsfvPVzM/Ev/wOE+6+WNoTnQAiCxeP2++Ef+hUPRiSvPzgNk4pWBtXNyfjKj0xU7D3bCw/98tm9vaw2gXZN8cP2RjZbm8v84Vbext6/Oh085JaX7X26WIYXhzwzfD7RLv+0GqjKBnkUWbQkNXepO0OVg00CG+hqWz1ZSmP3N6y3di693yaCjfFa8/9m6Q71u/LKfwrn+7i37BqYsS8kaJeoatTtRRfHct7V/+eOaqaUfopQazlARdKtOXv43b5mbWlk6U0HhzLV963YtjAZc5bNSYBj4ZBafxhJ58DvKVVCdJKBzYQYet+7bPDZb3ZP8evlIi8qABcGKTOxg8N/7T2MmIT3z6+Df99nkXRVw/NbstdebjFgeM5i8PyC8mWZOL929+6oCX2MaEduzp2PotyMYJjo1dOdBBeHe3rodOzYt37s0D/lU2Ld2biqMiO55p3nGRd1/pobHew5sqvT5bEXTxzuWHcAXzN34brRi/86mCiutSslduxUj4KD9+tFXYUsaed+W91WlYuFeBbChNn/DyA8f3rvyUjZo5l5RfPRSyBzsjxDII6zctcvR9zcwEKeofhxt7+S1YziVP24XgXnVP26sYulEbG/90H/vNze2xF/PqyJCifeO6ej8/e8TskuzNEhR9SLS3FrxzJEIoQCBQIMWSK0BLcO6ct80r1YwEK9e7Tzu3NtuvbrX0R5yAeHIvndDYZ6dfglIQz661/7j9689CklhpS/ciBFy0D4efDVfhtTEwA3bInxqX9M8IOpaNzx5rINk7tyerIbe7aMpqO7c0fjk+xR2NmCtXT4RI7jvRBZAbd15//rQ5bHo9ndrgxnVcoyim/4e37Wrt68Ppnb1bKigVJ1OglACRG4JhHDN7j0Nee6eWQfQnc/VbnDv2n16UIRdFvUqpCGbAqm1FqST1PqYDhQjLiK+QEKhg/u3Sea+eB6ieOTE/nFbV3w/wNEPo+ra2WQRhdy6swLSbs6I2qTcYuTTsWBgxUWgAbQAUEiKOr5tx4zGBIsXI8LIV8xcaztR/3S3PrO433QBoV2x7lg3TNmuAiX91pVHP/1MXFwJWIpUEoRGC5lbsr25939YhNq9x4OaVS1fipWrT5ctQns/aE9R1NftjqVx0r7AG5CK4l9XS6G56yeNE9fPXbwzE+o6Viksf7HY+oNdzqMrZx7f9+0OllRcUKLUrx72bF3+YREgWp8Rn/blhmjwv1SuMExhr7K6VGhAaMdE6GIBVykkGLmLi6diL35gVd+BPQz+T9W/3CYndjQyt5zSRYRmeCDeeFhptCNMgS4mDJQQrL6KNoQCtOPbuKMqsXLnZg0GbiD5MNi7syqpnwR73bwAkHrh4evYnmqT4rG5q/LTg68vVwQUhQqJFpQz9XCc9u3bKu2JP9g9HZGCnAtPfw2Vfe/VLa9MZesLSBh+UAlf8A3IhdC5fEUBieyBky3J68/P/SFTb4l8KmIB2dGB7I//oW320wdXbiK8SQFCFxGGe+/3wb+/J5iwga6wGg42ppcDbe1TCzORaB1zxeo2LI2mAam1QINOurHGdLxYi0MuKw0tln/7YOs/0JpMrNK0z17468Xg5n//g5EJff10n0VRQ3D2zEr4wN4umZgOVIet5WJVPrIZaWptS0C5luECWgg0aENPDq7MT6pKQGhTLjzq++DA7Ni4WatdDRqLgS9eWZsObQvnXC2E8unh70/9Zd33aUfqArQQ6LK4vu59m0JJUn99KSi2bt9QKZFovZit3b9r3Qr3/rfF9v3bQz4QrgQS5huQUQGwhQlu+vmtp8bf+w8d7V0ZuPTAQUip0cmJ2w8yqvsf2HFov3x9aSDlzRVSOVaBdk2yiwOJX360eAnYHFr+P16CfO/kdv1sIr2hZsPzxYLwZ0fHvxhQYEvDVQCT0zt6Yg+zBaE9K7zSaG052dzpbZ8du/ukWG0l11NM/j8H/4OjmfvfmQbFcz6xlOLlr/f9/Z0XLqS21/Y8jBdU7F7kdQIkhl3gQwN5aWoXsAP69mlhRkxA2aZhOlf8H2/lKym1FApwpMwsM/Nt8tO/en0zbSufY9rn1N97atZOBoq42lTKKItx5KdJG1AR5/WzqxPNB/fEgipH1ceHnQTwcIjxF5HdB5qRwgVSOrJ2WddCSQOW7l2bimF39jR3bNtW8+APk8oKkrnd/6wWaqoX8Ndu3dp69Yusp6z0ua4sIGsZRnD6/KaPd94Yw9iqbw8AyaW+g5X347eb93y0eK7geDdifF5DxvDldcHrB7s3fbB0HvCfkizerMRx/MKXHxx472fhr/NF7GwkIpI87T+yP/Vbk9XjEakth9dVf7Xl7q8vr9//8fTFgvebSN+JskKsPTkPbZp4AGztywsgZ4pkguI6a0rBwOKuaOq+ZaVMqUG7yieky8LSx7+c/e1CxgnlBcnf9fyoLWf7KMwJn+uWx7c+RmHk089ff//7F5enrINdHaa74RhF9x99fvHS1en0hve7wzkbFszKtVtYARlUU2cHXQPz2NHbafDX9TU9fpKxJ0auLkfgwLs7Jh2Amm7noe0hWN02QWV77nWGWKuYUh2N/TdHPj+57p7TEUe1LqatrunFmoOph18M/ujYz/P9ieqdBtmzbYKK+oaXuql5aiFL/tbLn3zw4dTtTNXBAO5X+Jo753Vow8LIVx0HPjUeTC8DwzN7D+8Zm67LpjCbuxbmZhWIWH1ohY7GtJmLJtGzF+7++P0fjT1M1RyMwFeOYHy5d9uOwZnOvlxmJCjq1k0Ra51LNPjHdFvnw0UN+NdFRu3OxdcPm5sGk2y1l3WjnInUj1NTn/a5lh9S+Za5XLsznbo3fawmK4WCYKh+iUCjnrK1N0HOVyDqmzZu8t14+MerL5s3GMSqim0+Va8f9H9154lTu10SaN38kLWPtixNLw/cmHegdc++oKJ4s72cH/vjK5Pag0d9Y4uaolm/wOO6Ex02zR/XXbiX6/tsCg4evfWrK13H/7JDpx12Hr9xvfpDS/HhkUu/+WrsvX/s52GhXYa/DoLs+KjSZvsp9YcXirnfpz76hz6vzPvTzH2bFuFPelOE/6L+j78aOn7sL+XpqzYkzy99+s8dVKY9ObD5nz6yculiCozNJ+NwfF+F1OPatQJzXz/f+y/8PY4y0/n+HxwDMt+6P/qnt7i4+f8vSPRUS56Oz+MD+xZh74ln5+JA00ch+Jn169O+XZdjnacW4IPecw0tebpPtCnBJLMb319n8xeNV2/EL/pPBGRWQdO7HUmaPmz89onjTbtSAomZay+7/62fblp6eu37YQm2EyzIzUyu//s/zL+8cfXMy2BD16ZOM/8GbDmVff3oi98jOw70xRZuX2mpDxfYysfUfdF8cHtVcul/OddwvDVigq0tL2Z9fmDW2rV5Zd4JVb987NbsDY09urNly2bfxP1MwwFnwQxlH6UqjlmJF38Y6j5yoH7q4fNHIUBYtQv9iYp97eMJBa9/O7Pl0+PVuanrT1IGsjo3NGZu2xp//eXC/j3t8VkFDP51+NhHbclrZxM9p/aGVuZsIFD5eiDbvqUqHxgfmOmoYe7r+OfvbQk72XN3lim8923t+z9uS4+cSUt8lbmBReNI40pw9GGu7rB/JgP4q5ee5rb3Ljy5jo8N1ugjd8vOed/Kw3jkQKcj80MPza07lh4v7+9dnlaPb3U1mvWAuU48mwge7J6e02WQGnLP7j8yjdy+k3X7DoSGzj100coAXj+8+8z//j9y8lD1yO2V1l1N8znexLqdmzat3Buq2t+TyPH7/zvVvH1XjwRHSsy297erNJy7JyYXunbvjiC00B5efX3bF1TJ2maD279e8pMz2kTyNzfypsYyMhXNcvo3A8rMGuv9pO5+9yLszydqAgD66R+eVpp2qqNaAqxcOTcVi+XnfREg/esLRshNN9fz6tdDyco2AaAmvr5jRldUyLj7IlPZ6wPcO1+/DpuO0qB19ToLfD2z+CQTsxtOzL6ywXn65Yg/lozXSFj+wzXhI7G17uq0ECrf6wcY/c0zU+R6o3xxLsTAX0/4DDtWP3ZDG0ILDflwZ/j2NeGLN7QK8he+cLstYPTMfe0T6co6gXdfxFEXf4g3wJbdD8BftWW39VU//gD62aWBsEmjX/li3Ts6fUtLvKHCDFbu2FHrTLigRWbxxuOFpkO7I1W5rO78XGYBunaO/vDg3pje++F6a95L9tWUlG5aAsuDOYkNEH8ZFwghsgLc15NSOHkB6KXFsZRBcZV5uSBw04LiztLoSNI0KFTjE65UaQF69lVSsGpyZCgVAmYGl3wGgE6MLEvp2BqEkAKo3JR4NGm07v9sh/zisguw+GIsHjIA3PFxLXUKJpISJyMpzA7PSpEVkFiE+HBCkhckJ6R0bRcEhmBiSsqkAMgOL0iA3OiEIZ2MoJxyuP9BJkDFOyfqVxSAWdW2NKLV9Oy5WQN6Dm5+nAXZ2OTjjY60VGsK93083v9d/+2V0JGmTj+1fZrC7k96M+e+u3V3WLTvj+JZa1bXGl0AikJNodaUqPOUqkFTcjpHiYpVtabUdJ5C22F1rSmuKUxeeJC3dL7h8OaEsiieyrO6oqgCrVhVa0rVmkKtKa4AFGiKK4q7gKasuWvfBsW6fVtrlhdn7QiFSkg9dnqoQkR27GsK2opCwZsuKBRNB3eai9dvXbg53bwnJFxlyIKMveWDLqf/zpUzwx0+b3/LXPpmzpR69umCDFfxpzmzoNre2RHLqW9+Z/YdXK+kwFHw/KYMH3qnJe3wN12Y1b2Hm6ceXzg7bAhhO36ptTPZf2fh+L/88Y7si7O3l/lbrs4DWtsvXkn+VNf/rC++oph/MiKGR5qO7q3DzYCKnjrkm8vzVpRW197eyjtfTyIcn9CLA9eeVpmWf29Tzba97S+/HFB/u1ldK/5UBkOWW1LOt7ddA/gPdd+//uDVlHVig1VpZzd+JtK8PY2Kup5N4bMDbdvm1NjliaZgcPP+3CIiHOneaZ6bVGZJIptw/1byJ/TIpuqsKEUZK3kKoweP23bi5dNBO1h9tN0NJXjLGp1Ha/KBFVTG17ijN2YKije806woWfimb75Qf6c7tcEKqVICjquLQGzv1tqAL5ml6sNNYd7C8tNtgGj/YIei5IoftRq6FLCvP8z/nc5yEaIUIShZIoOAMHg7iwKfhVch8GiaefV3Oqn4265E67/TYf2tRzsmf6cfVc1+yC3FpfSkdYWVzQWdrFgLodxARUDLfDIl0aKI0KUpKxrSgvxKTggPwvTbGYQAqXUZdLhCGKbETU2Erb/b/XF23zbcJz/MYirEatrQaLc+tJwOuBlZRK8mNEKDQGgtUIGmWmUmx5aFpKhQQhTTBa5V34xLcixrCI1GgChQ2opmkxIh0JJVlRbFtI61mk291WS+GYryd/vnr5t7yd97amnHdU2jmOtIE2FMZSqsRMCvCrSrTKOIsvEJ0GjtKp+VmlySbjjKKtrWpiyibWFKjNzMDLauCfuUBkeZkkLlahIBn9ZaOcowiynHMIvlSY679R9uIHvXZa1F2C+Fm7C1FyPqt7LpjPZkRcx01i2DEfHnUo43EYo4yVwZ/CEzn3LK4AubuZTrSfqCppvJeBLRmK3ymewboW1popM2Wglfyi1GIOECqTwoF12ANHJuEXw6SXFLZ7ETKVwIJhw0gLQybhH8TlaBm0yAUFAgzYxCA0jfcg40GmFl3GIEsrliPr2wouzGKNpmzXccazB9c2ce5TzIfSfC/uS9sykvgQPHo0OXn7mezB0nmmau3s54ir2/T1+8mPLk3/lB7fz1S3lPoudHjVO3r+S9sOnTlvyTc+NeZPfH3Wpx4Ie5N0FEbRARcwnj3b47t+0Cuevg7f4sQMWH9ReeUhg90XLjniqo/Vh8PV8gNhzPfz1LobHj8P3bWYCKE81XHhRp/jx1YVwD1H5q/H4RwHey48pDF6DmVPAPCxqg4XjVmZfF1p96fTFeUPljcXbcrIqDCKfV2viO7jCAzM0p7eHwPqDq3qOsl23HoWXwm5ynpg9qaV7+dlJ7aTgWtPKXXmsvRs8BmhMXn2svVL4bXseNq8qDCu7qCtbPfjPpQTt17/gbw8s/PH8DUEjQwMbj9TNfThW0flSb/OYFYGz5zLr1Q7Zg80exp2cWgcC7O+k/lwPCJ3Zkb121C9pPVqfODAKy55PQo+8TQPC9zZErF23A/GC33X8hB2LjifrRr+YKPtqbe3QpCZgHTyZvX3QKqk51qAt3XAjsPhi6840SErSSrKXsPLzRAV7cXC8o2Ty0Pw/u7WwYj/UfZCDkZvHc1whmy0zWUzgIHXpMecnO+Ro4EruQ9KIHX7xbdXj7dwMeeHpj1462T9TX46WpZ1+bP2/b+Hnwwv3k2q0ePOywa/GxAg5UcWT6roaG3bB7/j4Q25Ng+8pjBfWHYduNaaCrm4pttyYK9tZxcPGWhprtNnsStzR070BufDQD1BxCbLkxDZGjS+ydf6Sg5jAcujYG1G2DbSPPCzb0siF2MQPNBx12X5/CYK39Bz5LAbmr39calBx897ANnLscER7Cf5EGvolLTxWbk5B6Xot3JTGsvCf13O416nY8nfDC7B+bTwbebf5+0kPyh/6TB+p/Ef1iQJeC8+LLxGc7q07tHzz7Sr8ZmshGqGp9vQyB7jzR7olZZHsNbAo8ABqbbVpqn+WwWv3QmxtR+HsSiF3xISCwIU+kc2oe0VQPHZVPbejwwyY55OBrk7Aj99ylagPUNw+lMPrSsD33wsHYaMI28QAwNqUQmxdmNe21mvX113P+tWo61QWw9M2gQen+z3oBfrgn8Gi8Uw+8vIP3zREXhidMb9o1EYarvTA30RFjY3Aw64WBu9u2Bv5y/ky+NJLnnx46WvNp6zf3SoK5Hx5v/6Rq+/HQ6RtvhNbUhMDfvTgFTZYNne5rZL0JVeGFDFRHoCo2mSPSMg0VNVNZIusWoTo440C9z4Y2XiNr/UpWRpeTmM0LUF39yiHUPA9VlTMZ6vwQap5bwb9+HCrD83nMVhtq/NMKgrElqKsYUf6GPIRan6/ZllMGwMhXNh79P24GOHfXwmv7MRvyv20swyYf8CIhvCHAMvLKU+JpazOxzcMznji/9EG0/sOhmx5wv3164GjkVOvlO6WRu3i34ifNDcc3DH27/Aagac6BrzG1AA24UCtn8dflIdyUmYB6INi4vESkdgUCNStJAtU2+KrSCWhULtQYsxjrgFBtZo7KaAJCoUVFqG4BrMpkVjakIVidXMFqXoRgVXoZs96FQF1mHmpCKaipHs1XRrIQrZpJG4DQ5ao+vDMOOP3nAsJDzacNGtTFOz68Vny2BFyfxntsvQv552G8C1mQ057cZ7rXCO6aGvaW+D563Dyw8dy4B+xzjw4f9H3WeflmafDojDq11Tqxf+Xy49yauQ7VWRChtIYKV0GEJLJOgVyXm0XUJYHGVAIRToFVs5jHjABmfTwJlUpBVMQxqiWIhnScgJWCoC+ukbUrYFYmc2Y0C6Iin0FX5MBoSMaRVYC/JrsI9REHwpEZjLALodhMwvCDQJdFbHy/LQ8sX7wexmPLJ1UAl6/68Bo4WQWM/OD3ZuxVwIu0VQ4BPl9aeWLhZWuT7AkOJj3x7Oa7HdaHwdMpD+TP3z++P3By25Xr2dKY+XL0+KHgppNN988urJHOIyoygN9WEHU1RFQabQEINGa4QDogghmwYksOIlzQkIhDAAWVcgk7BGC6Gp8vC5HIgo0IZsBXP5czauJA0HZAatARO48dBjCUhqAfMEQWJQHDyGekH4GmrAc+WgGY/t24wGPXX2YBrl618HxwC5C9LPAe3roIPA7KckgI+FOON/tFuI3Q1qUXypO6M/tupOnk4N28B3Ln7h8/GHjn0O3TbmkkL17b+nFFbPeRma/H1sZoa3HTS0DtFjsVYgyIbTCzkfGCyg1mPjaTBiq3kI5MZcHqaFyprn0BGG2tGS3FKFC5PpANzRZUb877GwZckBu6lvOh8SyYHesWGlZSQG1fWrcPZkE0t+R9kRFANKx3HNccBvztLUuRaQWydov7FBBlif6sKwPQf7oarz0nFgCuXQ3gufWADTx6UI7qNg2Z5zHKGJAQ9Cdcb2rA7vGzJzPoeGLuUk8fvfvPjnnB/uHJkf3mviPT/49bGs698/bn20Tnh01nL6+Jufe4GnKA6g+7DfUiB1Qc2kdqrKDleJuRfeUCDZ81irlFF4yODxvVdA6QncdaEc+yQOTAIW2/Kmh+v0NMpgE2flSpFudckF0nmuITCqj/YL1YSWpgw9EWnZsp2Hi0CWMwCQS3veNfmQTo+mlmkfLK/UcMBaTOPKrAozxyfBbg6tUAnoOfusDKDxG8y40OMDEvyiDXxUFatvLG5ERLE23VA1lvqv/FOw3WyeC5BS/kvx88dMDYcWTpj8uloZ5fmu37INJyrPPlpckySQFG8yZDAZid7X5HAxit3X5HF0TXNxiOAghtqgm4GiDSW+dqCivX16MUgNmyPuCoglB3s6spjG6K+V0NEOlpdjWAv7sVRWFNV73jaoDqrhoDVwOyaX2Fqwuqel0NhnS0l/oj21MA42dfWHjddjIPcOOKH8/yUAugvqScVX1LkHsWpYzhqmUQpqPLoAZktyl3pJ5rT6T/WH0sUPHzmR+yXsh+9+LdXUbfZ6++WygNVi7cX/9+k//IuzPXB5NlQQJSCooKQ1BcGIKiQkqKCykExQ0JWgAYQlBcGILiUrKqIQTFDUlxKSkupKS4kEJQXBiCokJCgatKM7o+anMBnv82j1fZ+2ke4PolP9673neBp09lOZrXa0g8rikHUoFp5lUZeJ3sCrCx+XrOG5OXNm+V3XufPdBeyJ0d+qBPdv10+rcpD+QHvwif2ujv+KTz2pnlcrgpkVa4VIULEiu2GYsIILHk+quCgB1PqUBFUIC7knLC1SagFpJGsNoA3JW01hVRA8gsOUYsDLjxhBONWYC9mHNDVZYAPR8PVAcE6OWkE6ryAfnllGlWBYDcclbocJUBOruQi8T8gLOYxQzlQj5KDny+dxrAPnu5Bq9i18k4wI0rIbzXfDgLrJytp4y+jUlgdlSUQ6DBkq5Tjpml9iCNzS9XysANucMnjnZ9O+2JzNnXJ3po/0j9XxkP6KnvBw5+ZIW2HeP3Q970/PkHhsAx9xypgtkzj5Vv29FGwfKVq8Te3Q9Mnh10Kg8c9sPMFxO5hmNb/DhD301Y6z7pAPXi/EusrUebBamrF52K9w4CM98N2G3H+kwYOL3gNL7T60cPff+yZvfRMMyceZ6tObEliB46P2wFTu0Bhs6PKDa/1wa5u+eStYcOSPTrr0b90glvlSV1/8hyAaa+mPHh1ThyMA2oa9cDePcdb9Kgr8+KctR2JkE/CVNOV5kCAjpXDvXU2ihknxjMlWHxestWGXon+H3CEyvfzpzYLDeckL+f8gCztx5U/Wid2fVOy+3zKS8s3R+QAimih2ph5kpepkN7WwSz/Ysy1buv4FpezncfDMPMhazM9G7xk3/yVGbV3o1gP3wghRPa2yyYvjcvsx3HgMnLSq5s2eoj9/ielOmtvX7yD57LuYZDMRi/YsuVXRsD8PSxzIjNu0AN3ZFC6K0bTNKPhmRy0z6B+/qazOXzUlBirHef1ID97GJG4DW4Z58C1K2rFt7l7l6Awdt+yij7ghomRiNlCZgZwKftcvBibFclLesfLpWBqy8/aKLlvef38p5YOj1/aGug+/PFs2NecB+cr3iny6o53vviwpTygNIAKm0FIWcBaR0RJDWojBGCpAVuMuyDrCG0Lx4U2EtVkE9XGjgTNUAev2DRBbUsqyFuQS4XNUgmwmAtRiW5+RhuPBSEpAFG3pAwFwadCwrcRABYyVdb5J2gNrKWxImH8CiqDr6TB8jcvRjCc8XOQwpQty+ZlLHquAskrwvKWb8pAUwtyLI0RnOAJfJlWRjtihHaMjKvy5C8IvdWya1bbw96Y+UPYyd3mY1/tXJ6SntAj/8+//4W09zxo/jXQ7aH4m48GEClfEDcCkJagzMbipGb9AGz0SB6Kgj5XFjiLEfBzgQt9JIfmLcqBFkX3BnZSH42BBkVEti5EOSSlSY6HsCNB4K4CRPceDCAOx8GtWxWYC/6gUSuyiAe95NOh0Ik41UejI0/DdiAjn/9OITnilPbs4C6c9FPGcMn84C+NyrL0hgD9IhLWRvCGoiItFsONeZvENZme8gpA6On9+ww/SfV2aw3cpcHjm2R1b9s+f195QGWvr+/51OfqD+5pf/yrK29MaWbyY1UARO6yWBCg5qhidScBcxn14nEbAXEJ5srSM/4ITtbWUkyLoEp1ST1mAa1kFsnkotRSM7XhVlO+iAzXRchueCHaaOO9Fw15EaaK0jGfWBPmc0kVwCWU7V+ZhcNUkvhKpLzkdJiR3cvAjgvTtt4r/m8GsC9ecVHGQNHugDGrvsoZ6jXBhbGIuUxJYDfyjrlYGq6q5L69a+myuHefbS/V8Y+Sn+pvJE5P/TONqP+eMfFW64XVm7fNj/fIKv37moc+W5QeVuc7gwmngeBubmOkB4IgjuR7GU8AzA1uzE4M++H1Eikg8kEkHpZ18SoDbC42BLQA37Qc8vrjbkVAxjytzG+JCD9OrqOsTSwMLPevzIWgPzDhhYxagPOC7GJEacg97ouxpgLaizXac2Mm6XIzqMdFCZv3fHjvfqjKgD37hVJObuPAaTPKsq6bpMCnieM8jjKEiANR5dlZaC9EXFo6ZkuA3yVfT/G1t33HpaBxLezx3sJnuq+ft31Ag/OigO7AsaG3t7c5duup8yz8KaJOIVPjU2v4oAem9jmf2QUzL1YX/8yLYCZ8V7xuA5wnoueTH9dAY/NntE0oKcnOmue2gDjE9t8A0HAnZjd5j6qBRKPmjpHlwE9stKj7jcCeiTRl3scKeB5clfqZQCYHNnmH7RZ3arYss+icOX6fbzL+uM1AOreJYty1uyOFww/pKz+bQrgmaC8pgQw0Kosucm6CGw2n+fKkrpWtQf2bDg/XQbS3y6c6EJ+2n3tjuOJ5d/N7j4cguiP1928mfaSv55qeVFb5M5w7902gMTdRMMihfn7SzWzEYD4uUo5bwJMXmkVsxS9+6K3vx0gdW+xYVEWudMcdyyA5DeVkRkLyN7M172MAajTZsWIHyB1PVe7SNGxq51jUQnMX6nLrlBiy1/0UujMfzlulqHqVA+A8/icRTnN9zYALJ6pKk9ofRJIDJtlsrGAiEw7ZdFJN2wR2T37rCw8HjpWQ+3J/NmlMrD8VepUmxCfHbh6OaG94J67uOFHFRLj4/dunFnWpTH/h/51okj8qxvNRgHP///l2iK8/u1wgyiw733t+im0L30VDBZbOn2jWRYw+puJeore+IIIherel46fwunfPGsUBdz6xrEoVPd/pyqL5S5+V2cCuAO/yYdKkTVL4ynXMsbP11DOcPjVUt7QI/f8lKc5lxTCvrtEeZ05UYl+4KPMw8mNPi3CMq3LM/zt5n1SbogM6LKkfxj/sEm3vPv8STlY/OPCBxs07x1+cDnnifzA2ezxRseN9B2a77c9MDLOqtPPKO4OxinuDC9RPP+IVRPPNKtOD1DcfblA8Uw/q9qPbYrqoXmK5wYzFM8Mp1g1+YDibj8lz57rt4OWdKWfsq5cvWz4pZJ+yuveuWT5RTxilil1ZSAobKrKNX5Dh/M+py9MeeMXBiMYlYcE5Z34MhnSavs+ocvB7OnxGpH1H9ph5r3BizMzUrjJ0LGDQdfL314TD+dNqV1lUd74wLyLEj7K7Dx6Kl0dqBRlUqOPF4RsMMrlPnuSQYfbrTKh7j8VdmVNuZi5Nye1r950y0Li1iRGxtgUpKypuwumoTNGzAIAAFZQOCBmMAAAsJ4AnQEqoAFsAD5JHIxEIqGhFcqvaCgEhKCHAFiA/gH4AfrMmEpV3wilvvP8F6O9uf0HlL62+w/M/6G85/+s9Yn9Y/z/sB/r1+wnrqesj93vUT/PP8l+1Hu4f9/1df23/eewB/cP8j1u3oReXL+53w5ful+5ntW///s/+d/6b/1f8ju/7+3/kn52/i/y/9u/tf7Mf2L9tviL/sfD3zz/4fJB9s/y39w/bf+/+3P/H/wfjT8c/7L7gPkF/L/5t/jP7r+6H+H+NT6r9je9U2v/QegX7W/Yv+T/gPyn9Gf+5/wvqb+f/23/gf4j92P8B9gP8n/on+z/O34k/2Hhh/cf9l/3PcC/n/9x/5v+j/z37O/TD/W/+n/M/m37g/pj/uf5v4Cf57/av+r/f/bI///ua/dT/6+6j+yX//eKvy9oOEYLjjxHbf4XPp3HzGWfj0FoH0m36oZBNGeegRf+LBLAYaYbXihbEn8UbiLXNprO4N8MYjqC94bzEqLpsiVsMwx2C7cBsgB6RxY6W3E3rRZlV9cWmgbtgHks4HdayDt9ZeaDh9fXR0/kt0bDn738s4E/FVxaSpBuDsp+TPnA3lz3xCOZG6rvurVWF2ZXOHpmKDffc9t1T5XI1NN1aF/2KST/U8sHyik8UcdZYrAHY5c3uZZMvNxqHnyy3rm1bvSBI5ZJ7M3BGUZUQx52eqY4+Bb/+pSxj5G1Gj7DkJ2aA28EdeJf2QMvnGRR6r7xDwPXxvIs22Q2ZG6DLvCzAfHHZFt7uy+sHwUwvBd/20Y+PVYy+Zvjd84eIoHjN+nKccBzK7Jbo5ekQvacKeUzfN7NkfKk4A/Yd9z/OZ5/7159doKloV9+zdbIPbCg7/HA75O+j4rqu0Yq4JZHufr4WpPx1UxihcdfityxValD9QNq/SOUVLecaOxEFcwPPuuf4AR7nKAg8grTUjst103Cws/dEXdbxw504+pAOnbtk74/RusTeTTLvpsVzM3DuKMtKdvCnOYZPbG4z7O0pLk1VMJieUS+g6yn2BTnD8dsVwveAPLGcYr9+VAjr30gOZIv6V0t+Tevb8mP6pN3ll/eRbfl5tFImBOnlXRwcoGtM1VQBiUpa0UxdWlxa9gFtaR/KeDNX67/uZFibxKCZ+fONtZvVv6DkVOP/0ZxF1OjQ66/6KeWrCU6n+psKmuReFLmVlclBl6SdP3IPcfI0I8aD4Rgtxcn/fSewmvSpl7ruNKdl30h+iYcDWQn7ghL9QvtuTu7r9TI8P7yajrR+M5ffT4G38MtQU/OqcONjuxIBnQ2O+8aVC+Lz09uPvgMW4/pOWff/5yy1Z+CkB62zLLgkx0NU2oKfvspldE/SVHlVmvXWoXC/cnPMRdXiXpxTK45Dv+Fc9u/DrAIkDm9939G2h+VXAdYj2CZkOKTnzvjZY2s+XivgFSOFGeCVNyCky+etJGy10tD2h2L2whueCvv/cZht8zOg4uLVWVQY5m+OD3YXZLrQYttzR9ySZ4+FeZsgv3mwkRH6owX5buHoVtCkmQ6VF+XogKP7je9StXSaYjRrqkmw+X8l+H+yAR1Innwr2W81Wy7R8LQtIxnakHuHP8DLcyi2IOZuLsYgSi6fq6RwZCC++WJpSe5XAqqR3I4hxYJj8ksGWYySUNOhdFKF5IgnyyUkoFrYCFpYy28xeK30yya7zqUAdYbaY5fLr67jlnwAP7g/Ln/McZmDjUQYUSAe5+Ne2CH3BkcF3XxXWITaSPsLN/x67pXxTeggkwvyuRkhIuTyMrsYjpPNP3IZc41oZ8wYGY1XAjtISH1I3Bwkc8Du46zX/TLJUnvsPNsnkkdcCPQKc2RbnXA8dj7pP425VMyVtbY1WzXcVC23qtPSImLIh4ZOAFtA1E1ki0GHEOfMlHUuH+EQxAgUWXFD4LXuSlunb2GWV282CXhJ6pit85CRTDnhEVXmGjlL9+6xQNJIjgEq2uhEl689Y7TMl96z8O317HCQFMAYRzX95empIOcLYB+OfxFzHGdqewmoQ/aKFw3RFqt/C1RtpC6ukNh1HC5FKw65IElq5iMtNvcMtw4s2MajeW/+qKtJCMbp58CWWC2ahZlbfJ19BFCEQojVLNvkA0Q3Ps5Cj5IIImdZvVPpEwtAw+rinNMziRjRTVw1Lp5KYmPpNyqpGK4asHJ+1WyJJgaea9AvShD5Tv1tzlBGRaM+wzHsKXdAaf2r/iZit5Flln+9XjCxzg9xk5+wzTXF+FGtGbcno/uSq0QovGYUBPHwAVEObREqZ73YpQyaQ1GP8W++uFlhLTzBRLb+7WX36E8FsUPhxuthiy+sviERZw7bkeG6qQy+/5OJF6lY2FqgYdJmia6NOP8wIes8X8CNueQPe9XUvthxbPSeU92CR0De5Gk+u7WrcH6UBtvZ0onvXq37naAo/u4fPnFVnXcBBypU7fdyEOclQxya3jNWjDeIVvSw23F0RmL1RyrBqz1jr/e/A3/sWw4cOt3sl/DgO3Wo3RI99laYQUt3cfNJ9a/N3HVz5rowyWBW3hWwDudgjUAqlIMdh6/XVUK/KEcLUT9fqBLqPesqrJDkPr8EqUgahjXXTyMRjN/RivDwB+P64UtstIP2/dRFCjjyHE29/ghDLbqKCaagzCD+AMIJa+ZUDgasYHCf4HAhlKOBE/ImjfeaGUtOxxFqT/9DJLBEesys7qryzNPHuUvt3RxYEW3qL5aGfFoTMeJTXrR3cmmM0lUXorJzgAseiSP2MJkqp1Tj4xdbxAsT1G0+x3o/JeGn5mbRsBnUOPUtq+dj7FZcYs8jNAjjrphIH8ZZwjfPN20nLjs3XsiCSpYIFd0GdJjFW7SHsjvb400lj+FzOu27P8k9SLJaiy9WOXIMLCWBITto5OuxVy9NScghRiIsUPx9ciN3rXoipNVxftwz2I6YvOO7jo69tfD+hY8sGlT32LF71Rdj24JJqeHpMqxaD/1LqDV0uYxygSdHf7qeGPJMus9nc9a/iegQj/1FFVsYHERXnWAr0OFGnnztu6qebEiSZErRGEy/59NJl5rJmvXQ6i7h0OC9NPP/Hvj4a3hcjLGPq1LMJW9s7mqv4vc7SPclKOpyGLnyuPpMpQ7fRLzwH3lxHGOKVkpUKBqpJFAvyqTQgJpOZnuiX/wY0DclRpMqSwFlIe0cjCAI363QLOgUmNM/GYZ+K5jgybboHiIj7bTMlSwj9CrMcRbAzbGpyUGNTD/lFUBvBkNIq/+/52D352g8bl3dc7ZHyC2zQitc10wWWSEd6ETVLEgVf92WGQHKIC13GdT7yNHhsveey6BnMdR3X2U45oOjoLdF8oa7tzM4Uz0EQhxULCjPpAAAcJ4AfMI5A6uF6n+YqNBHvoT1RjuaxlSttaeoHKTFbfOLTc9/rcjfr2kO/98JIWOCZwJV7pF+J5dBJKWlsTeiUvEr7QGFPa7j9o8+LWFYTHQBJsEMlCumRN9LqKQV6sx5le+n4xd2Tn3REwlzv4emztEKQJZxQBzy5OWKSdUtJ6dnXibDRvOUragYbbXi3k0Bo3l5iVUbO42jnoHKpvJxAJwwXq/nDPkIpJ53hhKkJNmly2OLmhez6inD6YlGO3IRmyHu+nznGTxQhVCFXr7Kq5pX6jMO/nkIxJsMuEWtrQetD6ht4qwDN1MtK9Kd7Wksfua5SMiPl2Eb+DDu8/R8BZFjHbGrirBWTfq7pUnm0Y5fQY5aDmHVo6br2HikVHaeIeuCIMJTBcz2t05OqGgV9Xt8dB0xCK4gZl8aYm2Bk8/AOHsPm1+kvhbAwkYIPpJLvnc8cKDtarMHGoTxzaj81eDGfmoKIMiamcEfeOlAMY/gWSubIL3TdmiPQ/kwhzzZKTtRWo8h2sUs1wTZ6akHgTSaux7q1RloR4EfmH/jOtNmFm7hpdMNHrp+O3LF17geGzvdv8M7Rns+C4ximJfJt4P3k2i0JtwGU8ViqYolijLLdv3lHXDdNxPDFbhLuo+EpwKYoMHQwC7DebztlczTN6eWm2h+NtMzsTiikLaSMK00cP4Tl0KG2gQx5XweLzksjn4rh27C4T7un+R13UTpYFcAPbt2tWRB6NZbB8nuAgQ4llVMm7XPhGJUfaYrxH4x+9wQJ06SDtVGhCnv/20VxVkQcrAJ/xgGBfwN+J8ZYTxtLbLnMV1YvHVH7ZnP3gO/uPPlHVG/LF3fkPv3mmCFPbTp+A2ib//+dL6EPJp6z0PUkgmVE9vgDSDr+Yf2HRCPf6lcW6yAun9vFwRA1BWg/QnP/B84zPh/9/RGgODXPFRl2daHH4DgsPECG/m+HX1eVWmbXLyiBh6fDetoi6/KtJMBkw7dOI5JubbLms76VZxZX2lyaVy9N9gxZ31qjayR4mPNyeZJx76C+kuEVjkrp9Po8gLFKtWEmFJqoLO8DlfVKReLxFHPZRyJJMk4y9sHF+yMv2gYkqsCVoElclKYzicLMbZwz9tEUvthW6WBx9R32xXkecHa9Cczm35pLx1cDla9k6jLbSpy912YiuTaij3YQTdXbCB++iocMG3Fkk/KQzkdzG3qt/l1djV7zKFjzr5x/AgTMMdVzqnQAx/WXy2i/P74MvbChC3fgoa2Tferp4CNBvRdZcAp/rt+/Z01AMRb2EogCFeaDUlfXU8EUYCDrj2hvlDBxaiEB/2be4UMAngD9hQlheAaYDF2C3Hm1ipgIsGsWfk7sxyFfT6T9SQgCKtV3yLtq90J3Y1B6PmqOmhHqAhFDcw4tJjD+89/1d10zG/PFwVdgczTkK6h8V2OkiRDApMw3qFXi1pBs60gsDmDBwUcnxdoTqPird4iRY/BNgaZvlA0Gvi8od0bcn1WnNZrSJ4jTcfACpVultesunKj8T5OPslr0XYscapaU+t2/LueosGT8y3pjOa7x0qqL/5nqZ8u/tr7c+uTx10fLlghwg+TgHNlq0nCZdxbDklw52zmM8ACiU4YjHIR5OlmPhnCjj7D6Nu0F6R+3dIS6lNT9/E/x3ZH6lj9ADhB4cXz3sxEFEBsMtzJJPkUap77yfdR1OvFgGX4570iBurcJinDwg/EelxEmtPEXGg5/4ijzXIIDv/rOR/TZOR0sSLwAfuz1SsURKwLSh7vrl/OPFvH4/ipD4RW6AglbQI+llcTRnV1ft5iqUK9k0CVr9h4F79PTtI1guH3otMnodAcrCeInNFHzdcruFR8LT/894gzf6zwTb+G8OnVOU/hfkRyrDF3Ic5BpyBDpuyw9J2i32J8U9oDsrnU4YifnE9CJSNrKIF5qqxmACq3JwbQ4Ef3+YJIQPJ4zFZukIfWckqWDhmhzLSf8x3R5R5WTL6RZEq45Ju4x0pJ77wbq5HSn1FLoGHfKQhtM4+8EzHun79GVm3qLq/4phoM/vVUxSEBTpLICG0Nygo3UeP43FrbDQnvvx0+FGyVTJiPSOQkDLDM5dvWeP0HuRM7wTM6C5MNVODfDJ2hJRT4OArZdJNv5RSwqmaw2Zl0wYwVdTYIBeZmnk+vCD78qwXGxPU2X7tDK6RCa9UOLVv24HwKVX/+rMQVBOCLRpX4ZX4w5St6/Wop/vpi94c2IX/pnWemqDE5hPU27LIEJL1WuUipZ2hYNtnfEOb3BazCrxGS18bu1bcZx2B2tNGCfyHe1MfRYQxaqWGdyKSp/gKnX6wSkH1bI9RRgSgXKtH+D2/imbCTz79uG/tC8fujufU+oMldXmEpyL5iNn0u4NKKj7T2JWvkSEZXuHfvNR2+Vlg68pT4C08zV6355YsX/qjqXDPjp0LeeakvPcmJp0PydsYXXyagjS3tHB17DTaxfxAfBw8C2FYiGoyOoHTavk+ZLesfrvWYFRGetYRYwhPGENaT1eToSkj2/AG/Rb5uRGIRYTHP7FnmRSe/iOEMvVH6I9Wnkkdb6MXBFCeVPuern1uEgigWv92mhwyX3gmmwgDlCSCw+nKExCzR0fcfSSa5BFYAHOv6Eb0FjxCv+0VJIwx8ZuLLiZ+0T3EgIO/zxITqoEyGVWrgFpv6AP3zxcRbp1y91MPLSxVQ/EFjXx14PzpauE8o3EaTso/FssO8O7n/HS8qOBXctCm5OpIEbe/IoaGQE7rTzAekJxR6ETHWLyqTa67SQNJZEBaRCVKQrGxYpz8XqnNK2LO5C0TZkgP8lz4012mu7Puj2zd2rrm82gUMf7geZP/9XNf/0B/CTcHUUBK9Z/8AGQgfCBDwB4JhgpIB3jbFONMscuTZreAuvWP/mLJc08qI0xUbrsXiauAnDDrpSd2x+B8RQAZrX9mgUfONuMmZcDzyz5jYdqJGSCWJijW8BJgOqk1tyyCZVYuGIbrdtIa++W7Byi7nqa13f/OdnrMVEEXPp0UF+zJ7V4q2bZLMQqx0RptbbNkpBC4obAmqzZ3mwMixGZVc6TSvL1cuGPa0YNwAUpMzeI1LEnHRYoYEXRDOqA+HmmJPF27xBUsDHEGeAeKzoRO6+duv5I+sMMzAPl8HZnzSmwAAdOGIL36XVQTDVa/UAhqHExcl3WxO4SzTjI+pAIe+hfbL6R85yQ06F/hTWGYPuzF1Osq6aSjriOQi7IJFssdoPTGvriSUu5n7adeozq73paqvwTTdT5eENBfAArXDq65qB7k7jmxMJEMecrXfRVXnJnF5PoWkir10J8TgMF857HFjDLL5QH9wHlIirxA3zLuR4arkQmzjigv6+IrGAKjKFfWnn9XfYfXZREwNtFGdhBDf88wsOoH0hQ2agwv7XYxpv/MzS1gNJy/NYDz9v/+zTcf+Si1KWWUQKDhjhvpwngU0DwskoJ/Sot/BrliJhwFfujhHn/OknIvKZ8SzcvK66D35GuU6MG4//vLadND7fCf1MkB4tXQZjNFFyPTxTrk9MLJ88vPTXNx8MDmvaf+ZszMRTxCOIm4ywkTjTFnSs2uRYGJf2wVoHjvRbvWlnY+yeQJGHo9cCLekIjDS6en50SMa+cIwSxKaKMnwSN1n1fsdpMriittJYS916wQmI14N9vMHZ6/lyH9YlfJ6YzpIraa0HCTuQbiHk7ZL50N7eDhHM8uMB1BZcugYaMpkO63jApWl4bCOK3dGDHmRaBuwAXGwe8Ozom0RgUo5I1238LWsiEh97Jyck06Z6BxpPHESn/Rxtfy/cjEJxtA9/B0nmAzmq3NjMAk8y3gnG5vawQLVayZy3lQiAnWv7Ir5/7eC7elPUjLmrwqm/cfF3rJyh+DL32rNaWYZu7ulPGaiCs0AbNefU+RyJvtXfssrvlc4glG85t+AXswawIO8tWsfkFk0Z3xqVyg3A2jGhqLLMu06fdYfo5DBywZ9ypxWW2iM4ajgikk8OZVVvF74iwVkpFsT6eINyj6LiDXykccXaOzUCBstzzoXbJ42wEQp0pTC0B9mtErDsSFsq9kb1zyxLma19iePf2asGyh48Mp1w3J5k1V3ay2VKq0yOSk4AQizcjQkI0Lz5kqZha8rOOaYl2LLbODZaEJuWu9fwsKVDmli6wYLJo3IzPkFt8yhmqLnzxvrpoTykKdyuoVrUH4PGluLM0/BOeueNhrP8vUiHAbHk4bG4wRfOGS5IevuCVEEtFToMyZNmMcD9BxAnIvbMpJEKcwBLb2VC4X+WHmkjdc4iaXk6q/mDDXxz+vwmyKG2neCe9LyvjKW0a/pAt4BNVeMsQXHbhRsMaHYW4LCXJAfWFMAfaWBEjexEIkafx3G0wZx3PIXj8TLs445UUGSbj3uhW+lF8sUNFq/L/ig8pf5YUiuLMckkHwFkQHcW/StE8YXMkxmiKaxRoiGI8JurkpkMVlHyXVwJZv2HbIYCS6pVxeQKY7LMUiGbidiHob6WCY2keQRuc/HhbnT+LBLCGF41+qQ+Dvj6zq3yWMIv3BFn/VtmReIuqjUYN2BiWp31ZB8zrtPrL7RI3p3C2zNy15CnnNaDoI6Chq1otZQ04vveqwJZXcM2XvhGG0RnpNxp2/qP3u1XXVNumNmDC+D0lPxWhgr3DgNrTZc6RlUEMiI34o3gM9e0UnxVLoB2nHn31DqLmOSE+nEJ2flpqIbfDNHjmaJGPYY8Ao69vNiOEPSGA4MmvFkNHkSusxkS29NQHPBzlRQ/QHf1AjGdNYAzx1fp+BViVXi/6W9cmXiZv4wetVmn469Zo66FYSeNAFZtrCC6PvJpZGAzHEaUMlfhAkFETqUF0GU4WGq6O3mqoyyPLABMH/QjmsvnLMM603/sU/ektbR7ReLvOB8pDZtuhxES6XlE/t+9shZxIxKksJuuKRN8KNPpPh2XCXRDrHCsX2gf3rsEY133dSO30k+Drqoiha3lD1n+wrVCj3MnG9ZF/0x7kBG5p8ZdavzGAEUhal/arSdviEwnpIm0/utCVkVr4hyt1jM87Td2XnpcC5womTz91V61AmcRAUb9o9RjM+mvZyEqN2SiwZTLNq4ZLEQb/yqIL203eeNFBIqn3xeTmVtd47DvrPDoYqqc5l0isybmHZJrHfvBoX4CFZ+QwbA0DiHzbTr5zlZTP7RUF/nlIbWeVKDcRClmOmGNA1M4lNbQl6cliQnOUwN2ig2NnFEsI2+xwTkyENNHPJPEVRy5nya4honNdNT6hHxaqY00C8dYyMoKSh9fsb+04AaDoF0Ht2uk6YnCa0V9hIjipelV9YP99FVQFsZna6o6ix8mSN7AIlq6hUMkDgVyHOplcVPPJoUYInd1yp1UXPygDp5mz36iXmfg2kSlQ7bMLwkS/9FIdzqi5P4PiqfnBiW6BDClLXozm1o462vthOc5zkMAun+Njh7wXwu5ZfPjQ02+7h2XXokVSz7+Fm6hKt+uqWv+We4KGZUxHL+EgfFQfGAze7ytMf+lQcDk0xVyK/45ZOzBvMetO67A92jlmfVcl9OJSLwbXWk/60OLtSHlTE6/56+fdPSBNzpzF5nHzoPtiewdqRS65Wek3hNzSlfzfjZPvnhS7TqyKKhgJZNg+zT0o/bnFHZeCFjkb2V6FjyjZspaWMmiIBjKBkeWVUDhCANuCLKvCrMsYZoeI4+U+cfIVMBuFORokQtdbTKF1M/si8SKsBQsag93pvVIYartuPH0LfEeQiWc3J8CxZ0Y0rMJdPV5YU90xOSTmLFeO36Kg/t4L7tFIS4xS08NRbeNE3q5rS6nN7wMU7+I62EcrRJAZa3QD++DodfBz/13ywpanyLGYrSfZu3nyUv2YTsgCcjKF/7Me1Yw0IZPvAeDzrFtrrMApolTvyrCPTmusGgTzShwRfh2oZ4IKL7WzQmD1jPc32LJ0qKvNrgCL143hTLCeVAHIfe71X5K0CebSOY9lk59Yw0EmFf6PzYb08faHTZgLkBjwILu5FU/Y2xfrxTOF3J4nQ39Z4OfT0o40VPBJwxTqpklklZpT4bCGdsdy9ZnBPtlrvjLbPMp3oNHIBnuYrhtxfgxDJTXxX17NXk3BKSVfq3H37geEarKhp1lnKIdeunLtDkZbyw3PQ5a1tUr5Zpy83FuKqztW7ZEdo+j5OuL0FRhHfqHatEsCmghjzDS9q8E46J0SnhpgjYL/XwygHkMt7sZixyv4tAK2+JCvK3cCTnT/b4FtloAq0bEPS1ucW9oczmM0oWQif6OUniWr3f1NYBeSGEvbbMEv6YF/pu89iAy/cDhoEEnKXQudLWKJ1bwvPYRHiNViExOrk+WY6g8hZXPnqhNmMp8OS0/JX5+kfb+ZcdRSQU3A6Jn1gpydqEYJyusEcNZHX4ehNPsQK90MlWfLcRVlniUolzWzYFoO2rJOpE9YYz4gju2op0mH6A50W88S43RTtCQjO4RER3JgLdQOjvWyurbFN8+jGglafk6GBi9jTSrqvJaDU014uzMdz+gwInC2C2EHeksqf8p2llix/XkT36XrqiGZZqEWsbE+rPdjTivhaoCBwk3GjihkvjkO1w9bhC+DKYJ4sbafoaSgCF9NJlq1XRdI3hq2tkSNwoSULVo1PNG305PwPswGyQUpAphCP1w8riRP2LzsYlRIq/ny4Trsp+0QjgCUooEEwZCa0eywPSyXckMyqwuvSGERYNJ1UNQ58pIUxKcbH3RJ2dX8uhjBSlrpyOIsck41CLCqMtV9hDoK1DZA+n3DuTEZbA/yX7P1pF8DG1QE27PJrRxDWLawjJIVizPCyVGsmKf2RBuLKb/RJAmQunq614UF7SLKDaQ1GO33HmwxqPOzCuVuygYfM/m8jH751CShrm8GUByQzLQ43dXqikm73u5GwN2Cpfs2xQzZyhEzkkbxuO9Tq8I7jG4+XrNc+ynJ23MeWgepJapdsoYA3YalMtWYedVb3x7kAmxDmyT9rziqFYFfoYlljFN/Sdl9i+GM0IUspFu5HixjiYV9foCnVthd1oIO+PAa68Vow67bUmNgSjR9uGUKrYMU/fiK/lrBs7NoZVqLPkfHcmVG6JXVoQ5/J+Q0oWBG4rxl8pbuh9Ya9zXf0PXL6IrAU+a1kIzzmTcTshjqb//1eGJRh245hoyTLbnxzzO+HTo/iETbGWXh97BE2wxouNzSpeIJ55jQiVe8C1RRyigmzbceebG+LLJrIxYo4dSoNsOtYrb3sfkaZwT4TjX6QjDJv/s0DPMsfItHMEw7H7EQJvUQzwtLifruuC27BaVGO5W8/rJUbylEQ3RSBmwlzfAZVXn2RYhfl9Q2gR82sbi3vPIr96p7HSx58rwLiMembvE5W7ecJsdS7VQNb5JcANY+XwTtwUX9LMT4nCYKN+Nu1DOGNd4DZmAr/SxWpXNHgLRX+KAmSg1ezQ5ImYiRwoLcdizAcvJ1OX5yCyKV3b15SQXhcTDVqkBMxIZlxhu+StrAtCRxFCnCdoD/pIlQljwmbBCD08OBtCdkxuNyKWvdtIrPOHNM4641erRozKBVZR5Dyuto1pbynRsFeOuyr7Jxtes+rniw3L9Te3jhBAXyKFH2//edyTEy0SA/wWs7u36ebxVYeMU1oYGNBDB4Tp+WSg0O7fNo3Bm+cPwCcFr+ttkSkIH1EyGQMv4DyUwBv5idI8zsCWcuKezlrIV2OJThYo1d7XrCwmZY0ggHW9fFuEEe7SC9HQd2hB6UYxHE9e+k7NDiBPSesbOqNnlJ30OYxKV2lUNwHIYfwZRFqfaYzBrbr4Fr7jVRRdga3p5QeunhPdKgrsr3RnSj3e+IWCPtjcGwOPW81nUQa3tpKnymUNKKQFP1GqTt51HMiS8eur4Gt4EeMSXnQDjTqniCl1lmA5i4Yx6CQkisOGt0Nrw5NG7dCnPf1zViW7gqZ3rLyTgCV8bfqiGtf7O+Hm3mF7aS29d1Lg3PZn+W08DQm9sOTpipw0PEhQASOmrztURsLvAjbLpLkmDlg0VVIejc0BUuAkUUk86eZUI98KkWoBrj1GTFoZ1iYVPV0TMd+ESIEq+f0N6BgUsbCPLX3VbMj3N9PhG7+Pmnd2n03FavGUKvwEGSqjFk355xtN+Xoxr/DcYL5kH1f4RGogF7Sf3n7zutzTiGZwqTY4wy+DYU9RGdo0UGKqUJinBblAtAsI7Bjc5z96d0ma2kgsiv+7GI8B/0eV3vTjb9EyG1MhFZvshcWy62Vbf322Py2cCtN4IpFxDvgcz/KH8vXmq1Dfsw8GCeQ4F21DvRCC2HEB//+cJggWL5Ayso4wmg5qlblElbzWdjx/ytR29uJVbHXF9C/A8PNRTj2+2tZ60dv9PC+2txB2OKtZ1A2zsm5XiQR+fMBDkA9KuA8PFu87YRxDEa5B+bx+l3RUTtS5j7aDglpGKW+7qyDRKa/advlM7xSI3gFPatPD0ZszzHqZQRzoW7/CbR1K7rULE3Ew4S9WLn0mIh6k0LjeSI1W4dHgIe0ntm/XnP2qFjjz0rl0PvWa6qWospUBz9gV+855Nw2OEVDnL4fLfiMM4gUqSawyFHoY1MqcPJWkHnPXxX5m+ehaJoxkqyKnCbVAZUJgIGO7IVxCKldBIxkAhGJwRrEeR4AkoOERPYtkau//Zs1MIJfLBIM79D0LsAJuhvNoevYCkS2KzBcLOiTEvo0nQBBgFMQTcALxabGTdpGnuTdYVDgVKcVRL7odugbIzKI6xZWTqEU/texVgSnHlIc8abq9kQ46JcJn8Wl/2KRFo5znS9VKa5bMxQ6Dk7E1Hm1P70bScVf1mSve+2wrEe49o8vN0NWeyv2STbZLjwcaZE5UWA8fJYNZzXdfea1ARUMChd4YjwsBfuyCqHTK/s/p17bILNskc6czFvIsTwQ66tSOfBF6AWXoZoh7BfMepgwkikZ6t8GSmXOq77O+stp1uDpNHDXOfFFXqsgv53KlAk3IixcxtS1aCw97WKaimQJs4REt0CjOc+p9+FF+dAXWeJ4xyn+VX6VEnTHJvw5DYjWXJMO1eTx9HggLBBDK8jspiXyhKf1QPoMelMsj0n2++rZqDf2vH1+BaHTvPf0wa8f4vMhQCpuw9ncR76wJ6sojj6Vpq7U3nXSy7BjPXFcbLB453W2OV/yIhUkaKcy3vvVBcBxqYBrenD9jNqXhJmfTwhyrqpAT4XeMbgUySAI0HAoJyh/5yYXiNod7VDKzPn2wOWf7O6NDps3abBjTmTW9AKk92yE7yxJnDohQ5ApckbQuxmlEylcKBZcwnKRJsR9XhFSfa3E2QaB5Msu5rxzKwzpBmQQfZFYza47BWCBbqmft/gCGtqIbllFBbpQslS4/DM87Eya7yRbVQURWAUEieYstC4mSj7kNKc3eQQsMMiJlQ5JPmBExKpBXZEoeQIf+MNQujOrX9GsDRZw+b3Z/omd6zumdqz5eEreUNZHvSNMXRgOkIwBXB0tnIHTBTrZoLaQ2lU/h4Exk2k7pzQZyY3H5RRZMPU4Snx0OcuX7WNQuJGQDRnIJlQGADfBydmapj/EXS2NzByIsIe3dorzS8gs3lQpx+7JWf5JjI3ll+AbqVMezswD5fWBrzI+uupR4AbkffdHsuanmXWrvzRE03SZS38Z50Wya83W4mECSgnPWUtqs+n2nwtD80ArMFfuZaR/9pZDNc+12Fyk707b09UwtDxH7iYVPOzMUDsiGLLl48a43H5ojIGfnjQB2KMi/33Pi7ooqZ2ORvAveb39BJ6EuW3VwE6dHFkOqiZasuJa9DCbWfmHdcAXa7MRvZVAbYHBnhNceQ7knPfE5/tMDZbPyyN/PyjJ2kmQd24XnnByMs7oe6whBtlM8l88R7VyKz5nSvxB/CCmzPQYRbo1UmR11a0xpw7RdwFq+UHaoaCVmaGftSuoNJnajLsdamuHT98loF6ZZ0ofwtaIMdRkzWl7RuMrhSjvdJ2+IHnLY8DMphJktDEomxKOhF4cbqBSCzComWcN28sNApCe3Ig6EWQEfetJ6rPGMGt3bCMgDypnS8O5+U65zyNXtn4SPpdT93BTDOV7i5A6WoKAuHg2ifx2ZlpXORyVKVkG5XIFl5kFouNZeNyTTLaB2rjJZN5cFvgsIVXFtivUX9L1s4Sn0LfMT+nKoXGrLLWvtTyTxoo4pWFdfyW0YexwCnsin3xsvmMMYRvXaZOjXXFOkYqGP/yHbUPpHtjcKzhOvHcrwHpn8DoR3AYd0DDoprcpnwEqvfyYtuEGvQi06dkzdOGAO3UasQuexaPJf5wXiYxTSryWlqqaW3zkJa1vdLXNYFj8zmdmcfXuUraAuF+QkcCL2xgU3RGaI8zcqpRf0KCt9KFWJ7QgEWj40negbuFe1tKccxv988tPRLfMRx7imz/b4/hZZEjQYVfIINZis0EcxdpJ4Zd95pcTb/LX/GfPfoUVUt3mHxiTIkTLnYJFxlbOmtZ64//0ap4GG6JG/9yDKWbhp3KszjYriagVlwg/9nV3ZfHYaGDkZ1Tr1awci08Co3GaJpP6Qgxe/Wx7baCbuWIeuRBp1kVjn68hSXdpbn0XuvFkYWgi1gvVwv06FkmhTAa5dmQGaxonYgLabnFnqNgdGubx4ua0biwdylRrDYbM3IfCj9I2v7TBUYTs2dkRCsKPmYQp1skpXEbGmpvCTXNCEodDkfEAfVujxieTw3714fH2KzEQDD2JQRUjxizGOU8OUbfdcS68KK6+PKsQ9U+NnSMGVYUP72au3i6wFOziKkTCcuYqPIXS+AFR4/oqY1BT/1ZRYOo3jABHdtPL/GQJSyHcokwDorycKhAWGhJxIrP5l1iHOQ8pRw7Hzb9G7Zgb0AD1xt+EfWojZuIJE8uHOO60i2mUOyFQEHJjV4z4l4NCNcCJdXDj3Csr89q7PqBlhzsH8sDr8bqZ7yphK/fdATz3o26s5Q+1Ghnr3XMnTNujvfWbiIPPQTw2Qejnos8MWzRXuGKLr9v/joeZ1tsN2GVhE+JP6XmyiTfT3GG2PYXorZKRjXc5uu9dghQnIJNGeGwiq5PkMQkPd9WcAFwXukZFz4octJsUL0ZSS0ubAIO96Ye/fONX7PqbQBK3oZCYBm/WYW7WTRMERuLufwrSFxo7+aCGJmr2ycck7+ZOwtUL0a6y4bm4AuW2DSf2Z8L6nsba10Tlztcg1OeFv9Fi6SPz3nYt0oe/iItLIujYNwW7K7ZX8Oatf44p6xE5t7xE7dYMVJhIi4fNBnE0xx1FlLXs3j2CZmsBorT68rzHzr/Sz2BzN1Vk0URQ4Ho7COuvWVbqUbb9xv88ps5BFqm7xmv/kVUgZjqL+1WX66QPcxtlgaMcdbDEumcLSNLtjsYP0uixe2JtOC0A0+d5vDUseJ67XnLIwxg0kTIF8+ujKhi3/jLoaGsdKIGQ8KC7NEUy4TEFO5pdTDEvhCoPuuwb0Gy31kBCfJOxDyMxfT6DqkjS3q2Yt/w2jUVU56oy8XwBnzP5l5Hm/5RBBYQ6nw7gS4wzX3b1p8L/TKCmVJyWs/DRUL6/Abq9RnBdhnbdkEl2ov+XFO3urf0T/OVtF83sLUE3MLnINA0BrGSTztxDwhcrYBDhdPJfDb68vyPl8Xclk+k1HkUt7rskEdSE+W1IFFluHaMM57/thNBlDeiVfel+mFaMSZVuGyRDGs9iAvE4OBZof4ISDED3tlmQFzXp3YA+Au7WKYRN0o9rg0b76r1uwzmOFJA5dMCt4+XJa8uSdnAWuy1qEiLQZxDRc/NRxBCD5qLLSmHCNM9vKWTOMbtgiZFpfl8PTg1ldBdFzNbOZXrgMcc+zoxrz447s4l6zhrjhLNG7DWyoDD/NPmnTGcrcjL2kOQ51a7eg5daKs71kIy5AS1F43ZQb+8ZKOynpIpQt+KPIiKza6oJIm5WX65hOuxmYlFgx5TEfScduHguKBh4EuDR4mUwwoRr+1JCjrlX58PHmMNT7BQc8kowvKHFYkiX9HOnHeEn6WqSjBz4V+D4FWRxJ5BaOatpIB8lxxyIs2TJtecTuqWR6CjMb+1K4Yt1ybbjEMsl3SDHpsUiIdo5reymzYH431NUOhKvb1/gkeOIBe3GdRy1OY/ZoNiUj0snpGCim1Bdfe+zJkpp/cgRpkn7fZOeSt+9Dnoq1Bi00BmUtQk+3+ahpMo6SZnWd8doiYAmUsC3Z6iq7ofoBIGNydznztsfHpAcBn7ZsBZUoA+V1DbxzkavwOsD25X+nJb/YuxW7ZrnUrAIbeLRBydZGSkZG/pWwclYrBiX7gdB/nE+TWqiYbCpqbysFprhbO4beEiTgnN1EzNa8cbmERV8YUYwwgmQKcJ8ZVZnxYKs6hdpwAALgFiexpd0mcnJELAXc0zJ9oYr5neg+3LYZGeoIb/ZIyRdZRkIt8KujyiDWMTJRBAIW9AccWNS0/vLCTiNgxZ5yVoxYH71vQbegRoO6RXCtBoMRmXpskMIOmK0JrappYh7wLz836LEVDFz3a5VVBKl1eSydiDJBNl+iB1oMy5IVZUVNTdc5CCmvkgXCDy7dYnjvvmAfMCmpsVtQJI65Jy+SsJQCswhVgGzgHK6Io9eQo7bwrpRdQ65v0fMRSOVLsZCXPmu2tiCfVF0PhQ5s5LZGeRRDm6XmrplW5jaWZmyxo5vbFsRt4OinjuJdjeGn5V5GG+HFGBy69z0TEOX8TkFDB8G/EwFLQoH4oIVyhWWBPi9bRb6pgJ1vJrby3yumeuejna7KWIkEn2PtEh6eMB583U+TbpQV2np2GMFzxowmmt5ORG/5JfBLIwz4hsDFp3IqM2bROsAKyJVYLi4o+PemvPUXrZmnguQOsh4aNJNfxTvdUNgKnnsQvQbOH5X/ImCGxUv19cbmzTx9L4IW2PpRVn3/kiDrfyVrT9PVBVxgWcQAhfhoByUcZapt0BVqscFL5j8g4i9v/ivMT0kdgu9uNKU28oW4H5Nx9ccZacNO9DxdPfeshJUTODtVCwnjF+Ag+CLGsL6ifYU5uE8Qy3i3mVxhqJunOg2sO8pjMG7oODLODJaxXR0e6PvS5YdJWqzaZNjVTCzBvUg5iX7+buS/XtG6+/Jk0cQ5aYAZOLJEjPGqPmKjU8gvl/aLatXo8o0AAXD+LE7/Ext3a/cHFTBmW7NHiaa8QWEic2PzxmH0EdgtyBrDRMlSxAA" alt="Red River Tractor & Equipment" style={{height:54, width:"auto", objectFit:"contain"}} />
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {storageLoaded && (
            <div style={{display:"flex",alignItems:"center",gap:4,background:"#0f2a18",border:"1px solid #166534",borderRadius:12,padding:"2px 8px",fontSize:11,color:"#4ade80",fontWeight:600}}>
              <div style={{width:6,height:6,background:"#4ade80",borderRadius:"50%"}} />
              LIVE
            </div>
          )}
        </div>
        <div style={S.nav}>
          {[
            ["dashboard","Dashboard"],
            ["logistics","Logistics" + (logisticsItems.length ? ` (${logisticsItems.length})` : "")],
            ["list","Inventory"],
            ["invoice","Invoice"],
            ["report","Monthly Report"],
            ["add","+ Add Unit"],
            ["admin", adminUnlocked ? "⚙️ Admin" : "🔒 Admin"],
          ].map(([v,l]) => (
            <button key={v} style={S.navBtn(view===v||(v==="list"&&view==="detail"))} onClick={()=>setView(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div style={S.main}>
        {view==="dashboard"  && renderDashboard()}
        {view==="logistics"  && renderLogistics()}
        {view==="list"       && renderList()}
        {view==="invoice"    && renderInvoice()}
        {view==="report"     && renderReport()}
        {view==="detail"     && renderDetail()}
        {view==="admin"      && renderAdmin()}
        {view==="add" && (
          <div>
            <button style={{...S.btn("ghost"), marginBottom:16}} onClick={()=>setView("list")}>← Cancel</button>
            <div style={S.card}>
              <h2 style={{margin:"0 0 20px",fontSize:18,fontWeight:800,color:"#edf2fc"}}>Add New Equipment</h2>
              <div style={S.secTitle}>Unit Information</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                <div>
                  <label style={S.label}>Make</label>
                  <input style={S.input} value={newEquip.make} onChange={e=>setNE(p=>({...p,make:e.target.value}))} placeholder="John Deere" autoComplete="off" autoCorrect="off" spellCheck="false" />
                </div>
                <div>
                  <label style={S.label}>Model</label>
                  <input style={S.input} value={newEquip.model} onChange={e=>setNE(p=>({...p,model:e.target.value}))} placeholder="8370R" autoComplete="off" autoCorrect="off" spellCheck="false" />
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                <div>
                  <label style={S.label}>Year</label>
                  <input style={S.input} value={newEquip.year} onChange={e=>setNE(p=>({...p,year:e.target.value}))} placeholder="2021" autoComplete="off" />
                </div>
                <div>
                  <label style={S.label}>Hours</label>
                  <input style={S.input} type="number" inputMode="numeric" value={newEquip.hours} onChange={e=>setNE(p=>({...p,hours:e.target.value}))} placeholder="2450" />
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                <div>
                  <label style={S.label}>Serial Number</label>
                  <input style={S.input} value={newEquip.serialNumber} onChange={e=>setNE(p=>({...p,serialNumber:e.target.value}))} autoComplete="off" autoCorrect="off" spellCheck="false" />
                </div>
                <div>
                  <label style={S.label}>Equipment Type</label>
                  <select style={{...S.input,appearance:"none"}} value={newEquip.equipType} onChange={e=>setNE(p=>({...p,equipType:e.target.value}))}>
                    {["Farm","Construction","Truck","Attachment","Other"].map(o=><option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              </div>
              <hr style={S.divider} />
              <div style={S.secTitle}>Purchase Details</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                <div>
                  <label style={S.label}>Purchase Price ($)</label>
                  <input style={S.input} type="number" inputMode="decimal" value={newEquip.purchasePrice} onChange={e=>setNE(p=>({...p,purchasePrice:e.target.value}))} placeholder="0.00" />
                </div>
                <div>
                  <label style={S.label}>Purchased From</label>
                  <input style={S.input} value={newEquip.purchaseFrom} onChange={e=>setNE(p=>({...p,purchaseFrom:e.target.value}))} placeholder="Auction, dealer, etc." autoComplete="off" autoCorrect="off" spellCheck="false" />
                </div>
              </div>
              <div style={{marginBottom:12}}>
                <label style={S.label}>Check Number</label>
                <input style={S.input} value={newEquip.checkNumber} onChange={e=>setNE(p=>({...p,checkNumber:e.target.value}))} placeholder="e.g. 4521" autoComplete="off" autoCorrect="off" spellCheck="false" inputMode="numeric" />
              </div>
              <hr style={S.divider} />
              <div style={{marginBottom:12}}>
                <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
                  <input type="checkbox" checked={newEquip.isTradeIn} onChange={e=>setNE(p=>({...p,isTradeIn:e.target.checked}))} />
                  <span style={{color:"#facc15",fontWeight:600}}>This unit is a trade-in</span>
                </label>
              </div>
              {newEquip.isTradeIn && (
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                  <div>
                    <label style={S.label}>Traded In On PO #</label>
                    <input style={S.input} value={newEquip.tradeOnPoNumber} onChange={e=>setNE(p=>({...p,tradeOnPoNumber:e.target.value}))} placeholder="PO-26-0001" autoComplete="off" />
                  </div>
                  <div>
                    <label style={S.label}>Trade Allowance ($)</label>
                    <input style={S.input} type="number" inputMode="decimal" value={newEquip.tradeAllowance} onChange={e=>setNE(p=>({...p,tradeAllowance:e.target.value}))} placeholder="0.00" />
                  </div>
                </div>
              )}
              <div style={{marginBottom:16}}>
                <label style={S.label}>Notes</label>
                <textarea style={{...S.input,height:70,resize:"none"}} value={newEquip.notes} onChange={e=>setNE(p=>({...p,notes:e.target.value}))} placeholder="Condition, repairs needed, etc." />
              </div>
              <button style={{...S.btn("primary"),width:"100%",padding:"14px 0",fontSize:15}} onClick={addEquipment}>
                Create PO &amp; Add to Inventory
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Add Cost Modal ── */}
      {showAddCost && (
        <div style={S.modal} onClick={()=>setShowAddCost(false)}>
          <div style={S.modalCard} onClick={e=>e.stopPropagation()}>
            <h3 style={{margin:"0 0 16px",color:"#edf2fc"}}>Add Cost to {selected?.poNumber}</h3>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <Select label="Category" value={newCost.category} onChange={v=>setNC(p=>({...p,category:v}))} options={COST_CATEGORIES} />
              <Field label="Description" value={newCost.description} onChange={v=>setNC(p=>({...p,description:v}))} placeholder="e.g. Engine service, transport…" />
              <div style={S.grid2}>
                <Field label="Amount ($)" value={newCost.amount} onChange={v=>setNC(p=>({...p,amount:v}))} type="number" placeholder="0.00" />
                <Field label="Date" value={newCost.date} onChange={v=>setNC(p=>({...p,date:v}))} type="date" />
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:20}}>
              <button style={{...S.btn("ghost"),flex:1}} onClick={()=>setShowAddCost(false)}>Cancel</button>
              <button style={{...S.btn("primary"),flex:2}} onClick={()=>addCost(newCost)}>Add Cost</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Mark Sold Modal ── */}
      {showSell && (
        <div style={S.modal} onClick={()=>setShowSell(false)}>
          <div style={S.modalCard} onClick={e=>e.stopPropagation()}>
            <h3 style={{margin:"0 0 6px",color:"#edf2fc"}}>Mark Sold — {selected?.poNumber}</h3>
            <p style={{color:"#7a8aaa",fontSize:13,margin:"0 0 16px"}}>Total in unit: <strong style={{color:"#d4a817"}}>{fmt(getTotals(selected).totalIn)}</strong></p>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <Field label="Sale Price ($)" value={sellInfo.salePrice} onChange={v=>setSI(p=>({...p,salePrice:v}))} type="number" placeholder="0.00" />
              <Field label="Sold To" value={sellInfo.soldTo} onChange={v=>setSI(p=>({...p,soldTo:v}))} placeholder="Customer, dealer, etc." />
              <Field label="Sale Date" value={sellInfo.saleDate} onChange={v=>setSI(p=>({...p,saleDate:v}))} type="date" />
            </div>
            {sellInfo.salePrice && (() => {
              const sp = parseFloat(sellInfo.salePrice) || 0;
              const { totalIn, tradeAllowance } = getTotals(selected);
              const profit = sp - totalIn;
              const cashDue = sp - tradeAllowance;
              return (
                <div style={{marginTop:14,padding:"12px 14px",background:"#111520",borderRadius:8,display:"flex",flexDirection:"column",gap:6}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{color:"#7a8aaa"}}>Sale Price:</span>
                    <span style={{fontWeight:600,color:"#4ade80"}}>{fmt(sp)}</span>
                  </div>
                  {tradeAllowance > 0 && <>
                    <div style={{display:"flex",justifyContent:"space-between"}}>
                      <span style={{color:"#facc15"}}>Trade-In Allowance:</span>
                      <span style={{fontWeight:600,color:"#facc15"}}>− {fmt(tradeAllowance)}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid #2d4060",paddingTop:6}}>
                      <span style={{color:"#6abf4a",fontWeight:600}}>Cash Due from Buyer:</span>
                      <span style={{fontWeight:700,color:"#6abf4a"}}>{fmt(cashDue)}</span>
                    </div>
                  </>}
                  <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid #2d4060",paddingTop:6}}>
                    <span style={{color:"#7a8aaa"}}>Your Profit / Loss:</span>
                    <span style={{fontWeight:700,color:profit>=0?"#4ade80":"#f87171"}}>{fmt(profit)}</span>
                  </div>
                </div>
              );
            })()}
            <div style={{display:"flex",gap:8,marginTop:20}}>
              <button style={{...S.btn("ghost"),flex:1}} onClick={()=>setShowSell(false)}>Cancel</button>
              <button style={{...S.btn("success"),flex:2}} onClick={markSold}>Confirm Sale</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Trade-In Modal ── */}
      {showTradeIn && (
        <div style={S.modal} onClick={()=>setShowTradeIn(false)}>
          <div style={S.modalCard} onClick={e=>e.stopPropagation()}>
            <h3 style={{margin:"0 0 6px",color:"#edf2fc"}}>Record Trade-In on {selected?.poNumber}</h3>
            <p style={{color:"#7a8aaa",fontSize:13,margin:"0 0 16px"}}>The trade-in gets its own PO. The allowance is shown as a deduction on the sale — it does not affect this unit's cost basis or margin.</p>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <div style={S.grid3}>
                <Field label="Make" value={tradeInfo.make} onChange={v=>setTI(p=>({...p,make:v}))} />
                <Field label="Model" value={tradeInfo.model} onChange={v=>setTI(p=>({...p,model:v}))} />
                <Field label="Year" value={tradeInfo.year} onChange={v=>setTI(p=>({...p,year:v}))} />
              </div>
              <div style={S.grid2}>
                <Field label="Serial Number" value={tradeInfo.serialNumber} onChange={v=>setTI(p=>({...p,serialNumber:v}))} />
                <Field label="Hours" value={tradeInfo.hours} onChange={v=>setTI(p=>({...p,hours:v}))} type="number" />
              </div>
              <div style={S.grid2}>
                <Field label="Trade Allowance ($)" value={tradeInfo.tradeAllowance} onChange={v=>setTI(p=>({...p,tradeAllowance:v}))} type="number" placeholder="0.00" />
                <Select label="Equipment Type" value={tradeInfo.equipType} onChange={v=>setTI(p=>({...p,equipType:v}))} options={["Farm","Construction","Truck","Attachment","Other"]} />
              </div>
              <div>
                <label style={S.label}>Notes</label>
                <textarea style={{...S.input,height:60,resize:"vertical"}} value={tradeInfo.notes} onChange={e=>setTI(p=>({...p,notes:e.target.value}))} />
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:20}}>
              <button style={{...S.btn("ghost"),flex:1}} onClick={()=>setShowTradeIn(false)}>Cancel</button>
              <button style={{...S.btn("primary"),flex:2}} onClick={addTradeIn}>Add Trade-In to Inventory</button>
            </div>
          </div>
        </div>
      )}

      {/* ── AI Receipt Scan Modal ── */}
      {showReceiptModal && (
        <div style={S.modal} onClick={()=>{ if(!scanLoading){ setShowReceiptModal(null); setScanResult(null); setPendingUpload(null); setManualAmount(""); } }}>
          <div style={S.modalCard} onClick={e=>e.stopPropagation()}>
            <h3 style={{margin:"0 0 6px",color:"#edf2fc"}}>📷 AI Receipt Scan</h3>
            <p style={{color:"#7a8aaa",fontSize:13,margin:"0 0 16px"}}>Scanning your receipt and extracting expense details…</p>

            {pendingUpload?.preview && (
              <img src={pendingUpload.preview} alt="Receipt" style={{width:"100%",maxHeight:200,objectFit:"contain",borderRadius:8,background:"#111520",marginBottom:16,border:"1px solid #2e3a58"}} />
            )}

            {scanLoading && (
              <div style={{display:"flex",alignItems:"center",gap:12,padding:"20px 0",justifyContent:"center"}}>
                <div style={{width:20,height:20,border:"2px solid #b45309",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.8s linear infinite"}} />
                <span style={{color:"#8a9aba"}}>AI is reading your receipt…</span>
                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              </div>
            )}

            {!scanLoading && scanResult && (
              <div>
                {/* AI extracted details */}
                <div style={{background:"#111520",borderRadius:8,padding:14,marginBottom:14,border:"1px solid #2d4060"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                    <span style={{...S.secTitle,marginBottom:0}}>AI Extracted Details</span>
                    <span style={{fontSize:11,padding:"2px 8px",borderRadius:4,
                      background: scanResult.confidence==="high"?"#14530a":scanResult.confidence==="medium"?"#8a7010":"#7f1d1d",
                      color: scanResult.confidence==="high"?"#4ade80":scanResult.confidence==="medium"?"#facc15":"#f87171",
                      fontWeight:600}}>
                      {scanResult.confidence?.toUpperCase()} CONFIDENCE
                    </span>
                  </div>
                  <div style={S.grid2}>
                    <div><span style={S.label}>Vendor</span><span style={{color:"#edf2fc"}}>{scanResult.vendor||"—"}</span></div>
                    <div><span style={S.label}>Date</span><span style={{color:"#edf2fc"}}>{scanResult.date||"—"}</span></div>
                    <div><span style={S.label}>Category</span><span style={{color:"#edf2fc"}}>{scanResult.category}</span></div>
                    {scanResult.description && <div><span style={S.label}>Description</span><span style={{color:"#edf2fc",fontSize:12}}>{scanResult.description}</span></div>}
                  </div>
                </div>

                {/* Amount selection — AI or Manual */}
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:11,color:"#c9a227",textTransform:"uppercase",letterSpacing:"0.1em",fontWeight:700,marginBottom:10}}>
                    Choose Amount to Add
                  </div>

                  {/* Option A: Accept AI amount */}
                  <div style={{background: manualAmount==="" ? "#0f2a18" : "#1e2235",
                    border: `2px solid ${manualAmount==="" ? "#22c55e" : "#2a3055"}`,
                    borderRadius:10, padding:"12px 14px", marginBottom:10, cursor:"pointer",
                    transition:"all 0.15s"}}
                    onClick={()=>setManualAmount("")}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div style={{width:18,height:18,borderRadius:"50%",
                            border:`2px solid ${manualAmount===""?"#22c55e":"#4a5a7a"}`,
                            background:manualAmount===""?"#22c55e":"transparent",
                            flexShrink:0,transition:"all 0.15s"}} />
                          <span style={{fontWeight:700,color:"#edf2fc",fontSize:14}}>Accept AI Amount</span>
                        </div>
                        <div style={{fontSize:12,color:"#6a7a9a",marginTop:3,paddingLeft:26}}>Use what AI read from the receipt</div>
                      </div>
                      <span style={{fontSize:26,fontWeight:900,color:scanResult.total>0?"#22c55e":"#f87171",fontVariantNumeric:"tabular-nums"}}>
                        {fmt(scanResult.total)}
                      </span>
                    </div>
                    {scanResult.total === 0 && (
                      <div style={{fontSize:11,color:"#f87171",marginTop:6,paddingLeft:26}}>⚠️ AI could not find an amount — no cost will be added</div>
                    )}
                  </div>

                  {/* Option B: Enter manual amount */}
                  <div style={{background: manualAmount!=="" ? "#111828" : "#1e2235",
                    border: `2px solid ${manualAmount!=="" ? "#c9a227" : "#2a3055"}`,
                    borderRadius:10, padding:"12px 14px", transition:"all 0.15s"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                      <div style={{width:18,height:18,borderRadius:"50%",
                        border:`2px solid ${manualAmount!==""?"#c9a227":"#4a5a7a"}`,
                        background:manualAmount!==""?"#c9a227":"transparent",
                        flexShrink:0,transition:"all 0.15s"}} />
                      <span style={{fontWeight:700,color:"#edf2fc",fontSize:14}}>Enter Amount Manually</span>
                    </div>
                    <div style={{paddingLeft:26}}>
                      <label style={{...S.label,marginBottom:5}}>Correct Amount ($)</label>
                      <input
                        style={{...S.input, fontSize:18, fontWeight:700, color:"#c9a227",
                          border:`1px solid ${manualAmount!==""?"#c9a227":"#384870"}`}}
                        type="number"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={manualAmount}
                        onChange={e=>setManualAmount(e.target.value)}
                        onClick={e=>e.stopPropagation()}
                      />
                      {manualAmount!=="" && (
                        <div style={{fontSize:12,color:"#c9a227",marginTop:5}}>
                          {fmt(parseFloat(manualAmount)||0)} will be added to this PO
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Action buttons */}
                <div style={{display:"flex",gap:8}}>
                  <button style={{...S.btn("ghost"),flex:1}}
                    onClick={()=>{setShowReceiptModal(null);setScanResult(null);setPendingUpload(null);setManualAmount("");}}>
                    Cancel
                  </button>
                  <button style={{...S.btn("success"),flex:2}}
                    onClick={()=>confirmReceiptSave(manualAmount!=="" ? manualAmount : null)}>
                    ✓ Save Receipt &amp; Add {manualAmount!=="" ? fmt(parseFloat(manualAmount)||0) : fmt(scanResult.total)}
                  </button>
                </div>
              </div>
            )}

            {!scanLoading && !scanResult && (
              <div style={{textAlign:"center",color:"#f87171",padding:"16px 0"}}>
                Could not read receipt. Please try again with a clearer image.
                <div style={{marginTop:12}}>
                  <button style={S.btn("ghost")} onClick={()=>{setShowReceiptModal(null);setPendingUpload(null);setManualAmount("");}}>Close</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Document Viewer Modal ── */}
      {showDocViewer && (
        <div style={S.modal} onClick={()=>setShowDocViewer(null)}>
          <div style={{background:"#111520",border:"1px solid #2e3a58",borderRadius:12,padding:16,maxWidth:700,width:"100%",maxHeight:"90vh",overflow:"auto"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <span style={{color:"#8a9aba",fontSize:13}}>{showDocViewer.name}</span>
              <button style={S.btn("ghost")} onClick={()=>setShowDocViewer(null)}>✕ Close</button>
            </div>
            <img src={showDocViewer.src} alt={showDocViewer.name} style={{width:"100%",borderRadius:8,display:"block"}} />
          </div>
        </div>
      )}

      {/* ── Edit Logistics Modal ── */}
      {editLogId && (
        <div style={{...S.modal, alignItems:"flex-end", padding:0}} onClick={cancelEditLogItem}>
          <div style={{background:"#1e2235", border:"1px solid #c9a227", borderRadius:"16px 16px 0 0", padding:24, width:"100%", maxWidth:600, maxHeight:"90vh", overflowY:"auto", margin:"0 auto"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4}}>
              <h3 style={{margin:0, color:"#edf2fc", fontSize:17}}>Edit Logistics Item</h3>
              <button onClick={cancelEditLogItem} style={{background:"none", border:"none", color:"#8a9aba", fontSize:22, cursor:"pointer", padding:"0 4px", lineHeight:1}}>✕</button>
            </div>
            <p style={{color:"#6a7a9a", fontSize:13, margin:"0 0 20px"}}>Update details or delete this item.</p>
            <div style={{display:"flex", flexDirection:"column", gap:14}}>
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12}}>
                <div>
                  <label style={S.label}>Make</label>
                  <input style={S.input} value={editLogData.make||""} onChange={e=>setEditLogData(p=>({...p,make:e.target.value}))} autoComplete="off" autoCorrect="off" spellCheck="false" />
                </div>
                <div>
                  <label style={S.label}>Model</label>
                  <input style={S.input} value={editLogData.model||""} onChange={e=>setEditLogData(p=>({...p,model:e.target.value}))} autoComplete="off" autoCorrect="off" spellCheck="false" />
                </div>
              </div>
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12}}>
                <div>
                  <label style={S.label}>Year</label>
                  <input style={S.input} value={editLogData.year||""} onChange={e=>setEditLogData(p=>({...p,year:e.target.value}))} autoComplete="off" />
                </div>
                <div>
                  <label style={S.label}>Hours</label>
                  <input style={S.input} type="number" inputMode="numeric" value={editLogData.hours||""} onChange={e=>setEditLogData(p=>({...p,hours:e.target.value}))} />
                </div>
              </div>
              <div>
                <label style={S.label}>Serial Number</label>
                <input style={S.input} value={editLogData.serialNumber||""} onChange={e=>setEditLogData(p=>({...p,serialNumber:e.target.value}))} autoComplete="off" autoCorrect="off" spellCheck="false" />
              </div>
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12}}>
                <div>
                  <label style={S.label}>Purchase Price ($)</label>
                  <input style={S.input} type="number" inputMode="decimal" value={editLogData.price||""} onChange={e=>setEditLogData(p=>({...p,price:e.target.value}))} />
                </div>
                <div>
                  <label style={S.label}>Equipment Type</label>
                  <select style={{...S.input, appearance:"none"}} value={editLogData.equipType||"Farm"} onChange={e=>setEditLogData(p=>({...p,equipType:e.target.value}))}>
                    {["Farm","Construction","Truck","Attachment","Other"].map(o=><option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label style={S.label}>Dealer Name</label>
                <input style={S.input} value={editLogData.dealerName||""} onChange={e=>setEditLogData(p=>({...p,dealerName:e.target.value}))} autoComplete="off" autoCorrect="off" spellCheck="false" />
              </div>
              <div>
                <label style={S.label}>Location</label>
                <input style={S.input} value={editLogData.location||""} onChange={e=>setEditLogData(p=>({...p,location:e.target.value}))} placeholder="City, State" autoComplete="off" autoCorrect="off" spellCheck="false" />
              </div>
              <div>
                <label style={S.label}>Notes</label>
                <textarea style={{...S.input, height:70, resize:"none"}} value={editLogData.notes||""} onChange={e=>setEditLogData(p=>({...p,notes:e.target.value}))} />
              </div>
            </div>
            <div style={{display:"flex", gap:10, marginTop:24, paddingBottom:8}}>
              <button style={{...S.btn("danger"), flex:1, padding:"12px 0", fontSize:14}}
                onClick={()=>{ deleteLogisticsItem(editLogId); cancelEditLogItem(); }}>
                🗑 Delete
              </button>
              <button style={{...S.btn("ghost"), flex:1, padding:"12px 0", fontSize:14}}
                onClick={cancelEditLogItem}>
                Cancel
              </button>
              <button style={{...S.btn("primary"), flex:2, padding:"12px 0", fontSize:14}}
                onClick={saveEditLogItem}>
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Logistics Modal ── */}
      {showAddLogistics && (
        <div style={{...S.modal, alignItems:"flex-end", padding:0}}>
          <div style={{background:"#1e2436", border:"1px solid #b45309", borderRadius:"16px 16px 0 0", padding:24, width:"100%", maxWidth:600, maxHeight:"90vh", overflowY:"auto", margin:"0 auto"}}>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4}}>
              <h3 style={{margin:0, color:"#edf2fc", fontSize:17}}>Add Equipment to Logistics</h3>
              <button onClick={()=>setShowAddLogistics(false)} style={{background:"none", border:"none", color:"#8a9aba", fontSize:22, cursor:"pointer", padding:"0 4px", lineHeight:1}}>✕</button>
            </div>
            <p style={{color:"#7a8aaa", fontSize:13, margin:"0 0 20px"}}>Equipment purchased but not yet picked up.</p>

            <div style={{display:"flex", flexDirection:"column", gap:14}}>
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12}}>
                <div>
                  <label style={S.label}>Make *</label>
                  <input style={S.input} value={newLogItem.make} onChange={e=>setNLI(p=>({...p,make:e.target.value}))} placeholder="John Deere" autoComplete="off" autoCorrect="off" spellCheck="false" />
                </div>
                <div>
                  <label style={S.label}>Model *</label>
                  <input style={S.input} value={newLogItem.model} onChange={e=>setNLI(p=>({...p,model:e.target.value}))} placeholder="9620RX" autoComplete="off" autoCorrect="off" spellCheck="false" />
                </div>
              </div>

              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12}}>
                <div>
                  <label style={S.label}>Year</label>
                  <input style={S.input} value={newLogItem.year} onChange={e=>setNLI(p=>({...p,year:e.target.value}))} placeholder="2022" autoComplete="off" />
                </div>
                <div>
                  <label style={S.label}>Hours</label>
                  <input style={S.input} type="number" inputMode="numeric" value={newLogItem.hours} onChange={e=>setNLI(p=>({...p,hours:e.target.value}))} placeholder="1200" />
                </div>
              </div>

              <div>
                <label style={S.label}>Serial Number</label>
                <input style={S.input} value={newLogItem.serialNumber} onChange={e=>setNLI(p=>({...p,serialNumber:e.target.value}))} autoComplete="off" autoCorrect="off" spellCheck="false" />
              </div>

              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12}}>
                <div>
                  <label style={S.label}>Purchase Price ($)</label>
                  <input style={S.input} type="number" inputMode="decimal" value={newLogItem.price} onChange={e=>setNLI(p=>({...p,price:e.target.value}))} placeholder="0.00" />
                </div>
                <div>
                  <label style={S.label}>Equipment Type</label>
                  <select style={{...S.input, appearance:"none"}} value={newLogItem.equipType} onChange={e=>setNLI(p=>({...p,equipType:e.target.value}))}>
                    {["Farm","Construction","Truck","Attachment","Other"].map(o=><option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label style={S.label}>Dealer Name</label>
                <input style={S.input} value={newLogItem.dealerName} onChange={e=>setNLI(p=>({...p,dealerName:e.target.value}))} placeholder="ABC Equipment Co." autoComplete="off" autoCorrect="off" spellCheck="false" />
              </div>

              <div>
                <label style={S.label}>Location</label>
                <input style={S.input} value={newLogItem.location} onChange={e=>setNLI(p=>({...p,location:e.target.value}))} placeholder="City, State" autoComplete="off" autoCorrect="off" spellCheck="false" />
              </div>

              <div>
                <label style={S.label}>Notes</label>
                <textarea style={{...S.input, height:70, resize:"none"}} value={newLogItem.notes} onChange={e=>setNLI(p=>({...p,notes:e.target.value}))} placeholder="Condition, pickup notes, etc." />
              </div>
            </div>

            <div style={{display:"flex", gap:10, marginTop:24, paddingBottom:8}}>
              <button style={{...S.btn("ghost"), flex:1, padding:"12px 0", fontSize:14}} onClick={()=>setShowAddLogistics(false)}>Cancel</button>
              <button style={{...S.btn("primary"), flex:2, padding:"12px 0", fontSize:14}} onClick={addLogisticsItem}>Add to Logistics</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
