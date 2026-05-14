import { z } from "zod";
import { defineTool, type Tool } from "./_types.js";
import { jsonResult, mediaResult } from "./_helpers.js";

const SceneInputSchema = z
  .object({
    prompt: z.string().describe("Scene prompt (will be expanded if expand_scene is true)."),
    type: z
      .enum(["text-to-video", "image-to-video", "frame-to-frame"])
      .optional(),
    image_url: z.string().url().optional(),
    end_image_url: z.string().url().optional(),
    duration_seconds: z.number().positive().optional(),
    model: z.string().optional(),
    chain_from_previous: z
      .boolean()
      .optional()
      .describe("If true, use the previous scene's last frame as this scene's image_url."),
  })
  .passthrough();

const versely_create_movie = defineTool({
  name: "versely_create_movie",
  description:
    "Create a multi-scene movie project. Scenes are stored but NOT generated yet — call versely_generate_movie_scenes to start.",
  inputSchema: z
    .object({
      title: z.string(),
      description: z.string().optional(),
      aspect_ratio: z.string().optional(),
      default_model: z.string().optional(),
      scenes: z.array(SceneInputSchema).min(1),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const data = await ctx.client.post("/api/v1/movie/create", input);
    return jsonResult(data);
  },
});

const versely_list_movies = defineTool({
  name: "versely_list_movies",
  description: "List the authenticated user's movies (paginated).",
  inputSchema: z.object({
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get("/api/v1/movie/list", {
      query: { page: input.page, limit: input.limit },
    });
    return jsonResult(data);
  },
});

const versely_get_movie = defineTool({
  name: "versely_get_movie",
  description: "Get a movie with all its scenes and metadata.",
  inputSchema: z.object({ movie_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/movie/${encodeURIComponent(input.movie_id)}`,
    );
    return mediaResult(data, { idPrefix: `movie-${input.movie_id}` });
  },
});

const versely_delete_movie = defineTool({
  name: "versely_delete_movie",
  description: "Delete a movie and all its scenes.",
  inputSchema: z.object({ movie_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.delete(
      `/api/v1/movie/${encodeURIComponent(input.movie_id)}`,
    );
    return jsonResult(data);
  },
});

const versely_get_movie_status = defineTool({
  name: "versely_get_movie_status",
  description:
    "Get real-time generation status for a movie and each of its scenes (preferred over per-scene status polling).",
  inputSchema: z.object({ movie_id: z.string() }),
  handler: async (input, ctx) => {
    const data = await ctx.client.get(
      `/api/v1/movie/${encodeURIComponent(input.movie_id)}/status`,
    );
    return mediaResult(data, { idPrefix: `movie-${input.movie_id}-status` });
  },
});

const versely_generate_movie_scenes = defineTool({
  name: "versely_generate_movie_scenes",
  description:
    "Kick off generation for all pending scenes in a movie. Returns immediately; poll versely_get_movie_status to track progress.",
  inputSchema: z.object({
    movie_id: z.string(),
  }),
  handler: async (input, ctx) => {
    const data = await ctx.client.post(
      `/api/v1/movie/${encodeURIComponent(input.movie_id)}/generate`,
      {},
    );
    return jsonResult(data);
  },
});

const versely_combine_movie = defineTool({
  name: "versely_combine_movie",
  description:
    "Once all scenes are completed, combine them into the final movie video (server-side FFmpeg).",
  inputSchema: z
    .object({
      movie_id: z.string(),
      transition: z.string().optional(),
      audio_url: z.string().url().optional(),
    })
    .passthrough(),
  handler: async (input, ctx) => {
    const { movie_id, ...body } = input;
    const data = await ctx.client.post(
      `/api/v1/movie/${encodeURIComponent(movie_id)}/combine`,
      body,
    );
    return mediaResult(data, { idPrefix: `movie-${movie_id}-final` });
  },
});

export const movieTools: Tool[] = [
  versely_create_movie,
  versely_list_movies,
  versely_get_movie,
  versely_delete_movie,
  versely_get_movie_status,
  versely_generate_movie_scenes,
  versely_combine_movie,
];
