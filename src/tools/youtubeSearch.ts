import { VideoCandidate } from "../types";

const SEARCH_COST_UNITS = 100; // units per search request

interface YouTubeSearchItem {
  id: { videoId: string };
  snippet: {
    title: string;
    description: string;
    channelTitle: string;
  };
}

interface YouTubeSearchResponse {
  items: YouTubeSearchItem[];
}

export async function searchYouTube(
  query: string,
  apiKey: string,
  maxResults = 5
): Promise<VideoCandidate[]> {
  if (!apiKey) {
    throw new Error("YouTube API key is missing. Set YOUTUBE_API_KEY in .env");
  }

  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(maxResults),
    key: apiKey,
  });

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?${params}`
  );

  if (!res.ok) {
    throw new Error(
      `YouTube API error ${res.status}: ${await res.text()} ` +
        `(query="${query}", cost=${SEARCH_COST_UNITS} units)`
    );
  }

  const data = (await res.json()) as YouTubeSearchResponse;

  return (data.items ?? [])
    .filter((item) => !!item.id?.videoId)
    .map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      channelTitle: item.snippet.channelTitle,
    }));
}
