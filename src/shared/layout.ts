import { z } from 'zod';

/** JSON seat-map layout: sections > rows > seats, price tiers, accessible seats and decor. */
export const SeatSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{1,12}$/),
  label: z.string().min(1).max(16),
  x: z.number(),
  y: z.number(),
  tier: z.string(),
  accessible: z.boolean().optional(),
});

export const LayoutSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    kind: z.enum(['vehicle', 'hall']),
    width: z.number().positive(),
    height: z.number().positive(),
    seatSize: z.number().positive(),
    tiers: z.array(z.object({ id: z.string(), name: z.string(), priceKes: z.number().int().min(0) })).min(1),
    sections: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          rows: z.array(z.object({ id: z.string(), label: z.string(), seats: z.array(SeatSchema).min(1) })),
        }),
      )
      .min(1),
    decor: z.array(
      z.object({
        kind: z.enum(['stage', 'driver', 'door', 'label']),
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
        label: z.string().optional(),
      }),
    ),
  })
  .superRefine((layout, ctx) => {
    const tiers = new Set(layout.tiers.map((t) => t.id));
    const seen = new Set<string>();
    for (const section of layout.sections) {
      for (const row of section.rows) {
        for (const seat of row.seats) {
          if (seen.has(seat.id)) ctx.addIssue({ code: 'custom', message: `duplicate seat id ${seat.id}` });
          seen.add(seat.id);
          if (!tiers.has(seat.tier)) ctx.addIssue({ code: 'custom', message: `unknown tier ${seat.tier}` });
        }
      }
    }
  });

export type Layout = z.infer<typeof LayoutSchema>;
export type LayoutSeat = z.infer<typeof SeatSchema>;

export function flattenSeats(layout: Layout) {
  return layout.sections.flatMap((section) =>
    section.rows.flatMap((row) =>
      row.seats.map((seat) => ({
        ...seat,
        section: section.name,
        sectionId: section.id,
        rowLabel: row.label,
      })),
    ),
  );
}
