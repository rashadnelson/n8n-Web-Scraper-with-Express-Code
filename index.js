// Developed by RJ Nelson
// 6/15/2025

// IMPORTS
import express from "express";
import puppeteer from "puppeteer-extra";
import puppeteerLib from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());
puppeteer.executablePath = puppeteerLib.executablePath();
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

// CONFIG
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const URL = "https://www.kickstarter.com/discover/advanced?category_id=3&sort=newest";
const sheetbestUrl = "https://api.sheetbest.com/sheets/0b4bbec2-523b-4f4a-802d-4533850a301d";

// FUNCTIONS

const launchBrowser = async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  console.log("Launched browser");

  return { browser, page };
};

const getProjectInfo = async (page) => {
    const projectData = await page.evaluate(() => {
      const cardLinks = document.querySelectorAll(".project-card__title");
  
      return [...cardLinks].map((link) => {
        const creatorSpan = link.querySelector("span.do-not-visually-track");
  
        // Get creator name from span
        const creatorName = creatorSpan?.textContent.trim() || null;
  
        // Get full text and subtract creator name to isolate project name
        const fullText = link.textContent.trim();
        const projectName = creatorName
          ? fullText.replace(creatorName, "").trim()
          : fullText;
  
        return {
          projectName,
          creatorName,
          creatorProfile: link.href || null,
        };
      });
    });
  
    return projectData;
};
  

const fetchExistingSheetData = async () => {
    try {
      console.log("📡 Starting GET from Sheet.best...");
      const response = await axios.get(sheetbestUrl);
      console.log("📥 Sheet.best raw response:", response.data);
  
      const rows = response.data;
  
      if (!Array.isArray(rows)) {
        console.error("❗ Response is not an array. Check Sheet.best or sheet format.");
        return [];
      }
  
      if (rows.length === 0) {
        console.log("ℹ️ No existing data found. First run.");
      }
  
      return rows;
    } catch (error) {
      console.error("❌ Error fetching existing sheet data:", error.message);
      return [];
    }
};
  

const postToSheetBest = async (scrapedData) => {
    const existingRows = await fetchExistingSheetData();
  
    const normalize = (str) =>
      str?.toLowerCase().replace(/\s+/g, " ").trim() || "";
  
    const seenKeys = new Set(
      existingRows.map(
        (row) =>
          `${normalize(row["Project Name"])}|${normalize(row["Creator Name"])}`
      )
    );
  
    const newRows = scrapedData.filter((item) => {
      if (!item.projectName || !item.creatorName) return false;
      const key = `${normalize(item.projectName)}|${normalize(item.creatorName)}`;
      return !seenKeys.has(key);
    });
  
    if (newRows.length === 0) {
      console.log("🟡 No new unique projects found to upload.");
      return { uploaded: 0 };
    }
  
    // 🔁 Launch Puppeteer again to visit /about pages
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
  
    for (const item of newRows) {
      try {
        const profileUrl = item.creatorProfile?.endsWith("/about")
          ? item.creatorProfile
          : `${item.creatorProfile}/about`;
  
        await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  
        const bioText = await page.evaluate(() => {
            const container = document.querySelector(".grid-col-12.grid-col-8-sm.grid-col-6-md");
            if (!container) return "No profile container found.";
          
            return Array.from(container.querySelectorAll("p"))
              .map(p => p.innerText.trim())
              .filter(text => text.length > 0)
              .join(" ");
          });
  
        item.creatorBio = bioText;
      } catch (err) {
        console.error("❌ Error scraping creator bio:", err.message);
        item.creatorBio = "Error fetching bio";
      }
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
      console.log(`✅ Uploaded ${payload.length} new rows to Google Sheet.`);
      return { uploaded: payload.length };
    } catch (error) {
      console.error("❌ Upload error:", error.message);
      return { uploaded: 0, error: error.message };
    }
};
   

// ROUTE - Reflects message on Render URL that the server is up and running
app.get("/", (req, res) => {
    res.send("✅ Render server is up and responding to GET /");
  });

// ROUTE — Trigger this via HTTP POST
app.post("/run", async (req, res) => {
  console.log("🔁 Received /run request");

  try {
    const { browser, page } = await launchBrowser();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const projectData = await getProjectInfo(page);
    console.log("🔍 Scraped project data:", projectData);
    await browser.close();
    const result = await postToSheetBest(projectData);
    res.json({ message: "✅ Script completed", projectsScraped: projectData.length, ...result });
  } catch (error) {
    console.error("❌ Script error:", error.message);
    res.status(500).json({ error: "Internal script error", details: error.message });
  }
});

// START SERVER
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
