// Developed by RJ Nelson
// Final Render-Compatible Version

// IMPORTS
import express from "express";
import puppeteer from "puppeteer-extra";
import puppeteerLib from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

// SETUP
puppeteer.use(StealthPlugin());
puppeteer.executablePath = puppeteerLib.executablePath();

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());

const START_URL =
  "https://www.kickstarter.com/discover/advanced?category_id=3&sort=newest";
const SHEETBEST_URL =
  "https://api.sheetbest.com/sheets/0b4bbec2-523b-4f4a-802d-4533850a301d";

let lastResults = []; // Cache latest scrape results

// FUNCTIONS
async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  console.log("✅ Browser launched");
  return { browser, page };
}

async function getProjectInfo(page) {
  // Wait up to 30s and confirm at least one project card exists
  await page.waitForFunction(
    () => {
      return document.querySelectorAll(".js-react-proj-card").length > 0;
    },
    { timeout: 30000 }
  );

  return await page.evaluate(() => {
    return [...document.querySelectorAll(".js-react-proj-card")].map((card) => {
      const titleLink = card.querySelector("a.project-card__title");
      const projectName = titleLink?.childNodes[0]?.textContent.trim() || null;
      const creatorName =
        card.querySelector(".project-card__creator")?.textContent.trim() ||
        null;
      const creatorProfile = titleLink?.href || null;

      return { projectName, creatorName, creatorProfile };
    });
  });
}

async function fetchExistingSheetData() {
  try {
    const response = await axios.get(SHEETBEST_URL);
    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    console.error("❌ Error fetching sheet data:", err.message);
    return [];
  }
}

function deduplicate(scraped, existing) {
  const normalize = (s) => s?.toLowerCase().replace(/\s+/g, " ").trim() || "";
  const seenKeys = new Set(
    existing.map(
      (r) => `${normalize(r["Project Name"])}|${normalize(r["Creator Name"])}`
    )
  );

  return scraped.filter((item) => {
    if (!item.projectName || !item.creatorName) return false;
    const key = `${normalize(item.projectName)}|${normalize(item.creatorName)}`;
    return !seenKeys.has(key);
  });
}

async function enrichWithCreatorBio(page, row) {
  const cleanProfileUrl = row.creatorProfile?.split("?")[0] || "";
  const creatorUrl = `${cleanProfileUrl}/creator`;

  try {
    await page.goto(creatorUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("section.js-project-creator-content", {
      timeout: 20000,
    });

    // Scroll until bio is visible
    const targetSelector =
      "div.text-preline.do-not-visually-track.kds-type.kds-type-body-md";
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      found = await page.evaluate(
        (sel) => !!document.querySelector(sel),
        targetSelector
      );
      if (!found) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight / 2));
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const bio = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el?.innerText.trim() || "No bio found.";
    }, targetSelector);

    row.creatorBio = bio;
  } catch (err) {
    console.error("❌ Error loading creator bio:", err.message);
    row.creatorBio = "Error fetching bio";
  }
}

async function uploadToSheetBest(rows) {
  const payload = rows.map((item) => ({
    Id: uuidv4(),
    "Project Name": item.projectName,
    "Creator Name": item.creatorName,
    "Creator Profile": item.creatorProfile,
    "Creator Bio": item.creatorBio || "N/A",
    "Scraped At": new Date().toISOString(),
  }));

  try {
    await axios.post(SHEETBEST_URL, payload, {
      headers: { "Content-Type": "application/json" },
    });
    console.log(`✅ Uploaded ${payload.length} rows to Sheet.best`);
    return payload.length;
  } catch (err) {
    console.error("❌ Upload failed:", err.message);
    return 0;
  }
}

// API ROUTES
app.get("/", (req, res) =>
  res.send("✅ Render server online. Use POST /scrape to run.")
);

app.post("/scrape", async (req, res) => {
  console.log("🔁 Received /scrape request");

  try {
    const { browser, page } = await launchBrowser();
    const scraped = await getProjectInfo(page);
    await browser.close();

    const existing = await fetchExistingSheetData();
    const newRows = deduplicate(scraped, existing);

    if (newRows.length === 0) {
      console.log("🟡 No new unique projects.");
      return res.json({ message: "No new unique projects", uploaded: 0 });
    }

    // Fetch bios
    const bioBrowser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const bioPage = await bioBrowser.newPage();

    for (const row of newRows) {
      await enrichWithCreatorBio(bioPage, row);
    }

    await bioBrowser.close();
    const uploadedCount = await uploadToSheetBest(newRows);
    lastResults = newRows;

    res.json({
      message: "✅ Scrape complete",
      uploaded: uploadedCount,
      results: newRows,
    });
  } catch (err) {
    console.error("❌ Scrape error:", err.message);
    res.status(500).json({ error: "Internal error", details: err.message });
  }
});

app.get("/results", (req, res) => {
  res.json({
    message: "📝 Last scrape results",
    count: lastResults.length,
    data: lastResults,
  });
});

// START SERVER
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
