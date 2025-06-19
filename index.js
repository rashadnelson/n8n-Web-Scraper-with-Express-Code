// Developed by RJ Nelson
// Updated: 6/19/2025

// IMPORTS
import puppeteer from "puppeteer-extra";
import puppeteerLib from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());
puppeteer.executablePath = puppeteerLib.executablePath();
import express from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

// CONFIG
const URL =
  "https://www.kickstarter.com/discover/advanced?category_id=3&sort=newest";
const sheetbestUrl =
  "https://api.sheetbest.com/sheets/0b4bbec2-523b-4f4a-802d-4533850a301d";
const PORT = process.env.PORT || 3000;

// HELPERS
const normalize = (str) => str?.toLowerCase().replace(/\s+/g, " ").trim() || "";

// SCRAPE FUNCTIONS
async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1366, height: 768 },
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36"
  );
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  console.log("✅ Browser launched");
  return { browser, page };
}

async function waitForProjectCards(page) {
  const selector = ".js-react-proj-card";
  const success = await page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length > 0,
    { timeout: 30000 },
    selector
  );
  return success;
}

async function getProjectInfo(page) {
  await waitForProjectCards(page);
  return await page.evaluate(() => {
    const cards = document.querySelectorAll(".js-react-proj-card");
    return [...cards].map((card) => {
      const titleLink = card.querySelector("a.project-card__title");
      const projectName = titleLink?.childNodes[0]?.textContent.trim() || null;
      const creatorName =
        card.querySelector(".project-card__creator")?.textContent.trim() ||
        null;
      const creatorProfile = titleLink?.href || null;

      return {
        projectName,
        creatorName,
        creatorProfile,
      };
    });
  });
}

async function enrichWithCreatorBio(page, row) {
  const cleanProfileUrl = row.creatorProfile?.split("?")[0];
  const creatorUrl = `${cleanProfileUrl}/creator`;

  try {
    await page.goto(creatorUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector("section.js-project-creator-content", {
      timeout: 20000,
    });

    while (
      !(await page.$(
        "div.text-preline.do-not-visually-track.kds-type.kds-type-body-md"
      ))
    ) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight / 2));
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    const bio = await page.evaluate(() => {
      const el = document.querySelector(
        "div.text-preline.do-not-visually-track.kds-type.kds-type-body-md"
      );
      return el?.innerText.trim() || "No bio found.";
    });

    row.creatorBio = bio;
  } catch (err) {
    console.error("❌ Error loading creator bio:", err.message);
    row.creatorBio = "Error fetching bio";
  }
}

// SHEET INTEGRATION
async function fetchExistingSheetData() {
  try {
    const response = await axios.get(sheetbestUrl);
    console.log("📥 Sheet.best raw response:", response.data);
    const rows = response.data;
    if (!Array.isArray(rows)) throw new Error("Response is not an array");
    if (rows.length === 0) console.log("ℹ️ No existing data found. First run.");
    return rows;
  } catch (err) {
    console.error("❌ Error fetching sheet data:", err.message);
    return [];
  }
}

async function uploadNewRows(scrapedData) {
  const existing = await fetchExistingSheetData();
  const seen = new Set(
    existing.map(
      (r) => `${normalize(r["Project Name"])}|${normalize(r["Creator Name"])}`
    )
  );

  const newRows = scrapedData.filter((item) => {
    if (!item.projectName || !item.creatorName) return false;
    const key = `${normalize(item.projectName)}|${normalize(item.creatorName)}`;
    return !seen.has(key);
  });

  if (newRows.length === 0) {
    console.log("🟡 No new unique projects found to upload.");
    return { uploaded: 0 };
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  for (const row of newRows) {
    await enrichWithCreatorBio(page, row);
  }

  await browser.close();

  const payload = newRows.map((item) => ({
    Id: uuidv4(),
    "Project Name": item.projectName,
    "Creator Name": item.creatorName,
    "Creator Profile": item.creatorProfile,
    "Creator Bio": item.creatorBio || "N/A",
    "Scraped At": new Date().toISOString(),
  }));

  try {
    await axios.post(sheetbestUrl, payload, {
      headers: { "Content-Type": "application/json" },
    });
    console.log(`✅ Uploaded ${payload.length} rows`);
    return { uploaded: payload.length };
  } catch (err) {
    console.error("❌ Upload error:", err.message);
    return { uploaded: 0, error: err.message };
  }
}

// SERVER FOR N8N INTEGRATION
const app = express();
app.use(express.json());

app.get("/", (_, res) => {
  res.send("✅ GET / — Server is up");
});

app.post("/run", async (_, res) => {
  console.log("🔁 Received /run request");
  try {
    const { browser, page } = await launchBrowser();
    const projects = await getProjectInfo(page);
    await browser.close();
    console.log("🔍 Scraped project data:", projects);
    const result = await uploadNewRows(projects);
    res.json({
      message: "✅ Script completed",
      projectsScraped: projects.length,
      ...result,
    });
  } catch (err) {
    console.error("❌ Scrape error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
