import { test, expect } from "@playwright/test";
import { goToConversation, waitForPageReady } from "../helpers";

test.describe("Meta Panel Docked", () => {
  test("collapsed strip can open and close meta panel", async ({ page }) => {
    await goToConversation(page, "test-session");

    const stripButton = page.getByTestId("meta-panel-open-button");
    await expect(stripButton).toBeVisible();

    await stripButton.click();
    await expect(page.getByTestId("meta-panel")).toBeVisible();

    await page.getByTestId("meta-panel-close-button").click();
    await expect(page.getByTestId("meta-panel-open-button")).toBeVisible();
  });

  test("selection explain opens meta panel", async ({ page }) => {
    await goToConversation(page, "test-session");
    await waitForPageReady(page);

    await page.evaluate(() => {
      const root = document.querySelector('[data-meta-selection-root="true"]');
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let target: Text | null = null;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (node.textContent?.trim()) {
          target = node;
          break;
        }
      }
      if (!target) return;
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const explainButton = page.getByRole("button", { name: "Explain" });
    await expect(explainButton).toBeVisible({ timeout: 3000 });
    await explainButton.click();

    await expect(page.getByTestId("meta-panel")).toBeVisible();
  });
});
