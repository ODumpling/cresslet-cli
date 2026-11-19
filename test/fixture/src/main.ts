const count = document.getElementById("count")!;

async function visit() {
  const res = await fetch("/api/visits", { method: "POST" });
  const { visits } = (await res.json()) as { visits: number };
  count.textContent = String(visits);
}

document.getElementById("visit")!.addEventListener("click", visit);
visit();
