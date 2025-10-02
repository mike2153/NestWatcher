import React from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function Theme() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Theme</h1>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded border bg-card text-card-foreground p-4 space-y-2">
          <div className="font-medium">Buttons</div>
          <div className="space-x-2">
            <button className="rounded border border-border bg-primary px-3 py-1 text-primary-foreground">Primary</button>
            <button className="rounded border border-border bg-secondary px-3 py-1 text-secondary-foreground">Secondary</button>
            <button className="rounded border border-border bg-destructive px-3 py-1 text-destructive-foreground">Destructive</button>
            <button className="rounded border border-border px-3 py-1">Outline</button>
          </div>
        </div>
        <div className="rounded border bg-card text-card-foreground p-4 space-y-2">
          <div className="font-medium">Forms</div>
          <input className="w-full rounded border border-input bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Placeholder text" />
          <div className="text-sm text-muted-foreground">Muted foreground sample</div>
        </div>
        <div className="rounded border bg-card text-card-foreground p-4 space-y-2">
          <div className="font-medium">Surfaces</div>
          <div className="rounded border bg-accent p-2">bg-accent</div>
          <div className="rounded border bg-muted p-2">bg-muted</div>
          <div className="rounded border p-2">bg-card (this block)</div>
        </div>
      </div>
      <div className="rounded border p-4 bg-table text-[var(--table-text)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-2 py-1">Role</TableHead>
              <TableHead className="px-2 py-1">Class</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[
              ['Background', 'bg-background'],
              ['Foreground', 'text-foreground'],
              ['Border', 'border-border'],
              ['Muted', 'bg-muted / text-muted-foreground'],
              ['Primary', 'bg-primary / text-primary-foreground'],
              ['Secondary', 'bg-secondary / text-secondary-foreground'],
              ['Destructive', 'text-destructive / bg-destructive'],
              ['Ring', 'focus-visible:ring-ring']
            ].map(([label, cls]) => (
              <TableRow key={label}>
                <TableCell className="px-2 py-1">{label}</TableCell>
                <TableCell className="px-2 py-1 font-mono text-xs">{cls}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
