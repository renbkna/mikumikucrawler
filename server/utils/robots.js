import axios from 'axios';
import robotsParser from 'robots-parser';

// Robots.txt cache
const robotsCache = new Map();

export async function getRobotsRules(domain, dbPromise) {
  if (robotsCache.has(domain)) {
    return robotsCache.get(domain);
  }

  try {
    const db = await dbPromise;
    const domainSettings = await db.get(
      'SELECT robots_txt FROM domain_settings WHERE domain = ?',
      domain
    );

    if (domainSettings && domainSettings.robots_txt) {
      const robots = robotsParser(
        `http://${domain}/robots.txt`,
        domainSettings.robots_txt
      );
      robotsCache.set(domain, robots);
      return robots;
    }

    const response = await axios.get(`http://${domain}/robots.txt`, {
      timeout: 5000,
      maxRedirects: 3,
    });

    const robotsTxt = response.data;

    // Store in database
    await db.run(
      `INSERT OR REPLACE INTO domain_settings (domain, robots_txt) VALUES (?, ?)`,
      domain,
      robotsTxt
    );

    const robots = robotsParser(`http://${domain}/robots.txt`, robotsTxt);
    robotsCache.set(domain, robots);
    return robots;
  } catch (error) {
    // If robots.txt doesn't exist or can't be fetched, allow all
    const robots = robotsParser(`http://${domain}/robots.txt`, '');
    robotsCache.set(domain, robots);
    return robots;
  }
}
