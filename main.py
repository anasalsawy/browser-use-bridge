import asyncio
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from playwright.async_api import async_playwright

app = FastAPI()


class TaskRequest(BaseModel):
    url: str


@app.get("/")
async def health():
    return {"status": "ok"}


@app.post("/run-task")
async def run_task(task: TaskRequest):
    url = task.url

    try:
        async with async_playwright() as p:

            browser = await p.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu"
                ]
            )

            context = await browser.new_context()

            page = await context.new_page()

            await page.goto(url, timeout=60000)

            title = await page.title()

            content = await page.content()

            await browser.close()

            return {
                "status": "success",
                "url": url,
                "title": title,
                "content_length": len(content)
            }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
