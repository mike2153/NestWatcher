import React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function ThemeShowcase() {
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <h1 className="text-4xl font-bold text-foreground">Modern Theme Showcase</h1>
          <p className="text-lg text-muted-foreground">
            Experience the new modern design system with enhanced colors and interactions
          </p>
        </div>

        {/* Color Palette */}
        <Card>
          <CardHeader>
            <CardTitle>Color Palette</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Primary Colors */}
            <div>
              <h3 className="text-lg font-semibold mb-3">Primary (Indigo)</h3>
              <div className="flex flex-wrap gap-2">
                <Badge className="bg-primary-50 text-primary-900 border-primary-200">50</Badge>
                <Badge className="bg-primary-100 text-primary-900 border-primary-300">100</Badge>
                <Badge className="bg-primary-200 text-primary-900 border-primary-400">200</Badge>
                <Badge className="bg-primary-300 text-primary-900 border-primary-500">300</Badge>
                <Badge className="bg-primary-400 text-white border-primary-600">400</Badge>
                <Badge className="bg-primary-500 text-white border-primary-700">500</Badge>
                <Badge className="bg-primary-600 text-white border-primary-800">600</Badge>
                <Badge className="bg-primary-700 text-white border-primary-900">700</Badge>
                <Badge className="bg-primary-800 text-white border-primary-950">800</Badge>
                <Badge className="bg-primary-900 text-white border-primary-950">900</Badge>
              </div>
            </div>

            {/* Secondary Colors */}
            <div>
              <h3 className="text-lg font-semibold mb-3">Secondary (Emerald)</h3>
              <div className="flex flex-wrap gap-2">
                <Badge className="bg-secondary-50 text-secondary-900 border-secondary-200">50</Badge>
                <Badge className="bg-secondary-100 text-secondary-900 border-secondary-300">100</Badge>
                <Badge className="bg-secondary-200 text-secondary-900 border-secondary-400">200</Badge>
                <Badge className="bg-secondary-300 text-secondary-900 border-secondary-500">300</Badge>
                <Badge className="bg-secondary-400 text-white border-secondary-600">400</Badge>
                <Badge className="bg-secondary-500 text-white border-secondary-700">500</Badge>
                <Badge className="bg-secondary-600 text-white border-secondary-800">600</Badge>
                <Badge className="bg-secondary-700 text-white border-secondary-900">700</Badge>
                <Badge className="bg-secondary-800 text-white border-secondary-900">800</Badge>
                <Badge className="bg-secondary-900 text-white border-secondary-900">900</Badge>
              </div>
            </div>

            {/* Neutral Colors */}
            <div>
              <h3 className="text-lg font-semibold mb-3">Neutral (Slate)</h3>
              <div className="flex flex-wrap gap-2">
                <Badge className="bg-neutral-50 text-neutral-900 border-neutral-200">50</Badge>
                <Badge className="bg-neutral-100 text-neutral-900 border-neutral-300">100</Badge>
                <Badge className="bg-neutral-200 text-neutral-900 border-neutral-400">200</Badge>
                <Badge className="bg-neutral-300 text-neutral-900 border-neutral-500">300</Badge>
                <Badge className="bg-neutral-400 text-white border-neutral-600">400</Badge>
                <Badge className="bg-neutral-500 text-white border-neutral-700">500</Badge>
                <Badge className="bg-neutral-600 text-white border-neutral-800">600</Badge>
                <Badge className="bg-neutral-700 text-white border-neutral-900">700</Badge>
                <Badge className="bg-neutral-800 text-white border-neutral-900">800</Badge>
                <Badge className="bg-neutral-900 text-white border-neutral-950">900</Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Buttons */}
        <Card>
          <CardHeader>
            <CardTitle>Interactive Elements</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold mb-3">Buttons with Modern Hover Effects</h3>
              <div className="flex flex-wrap gap-3">
                <Button variant="default">Primary Button</Button>
                <Button variant="secondary">Secondary Button</Button>
                <Button variant="outline">Outline Button</Button>
                <Button variant="ghost">Ghost Button</Button>
                <Button variant="destructive">Destructive Button</Button>
                <Button variant="link">Link Button</Button>
              </div>
            </div>

            <Separator />

            <div>
              <h3 className="text-lg font-semibold mb-3">Button Sizes</h3>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm">Small</Button>
                <Button size="default">Default</Button>
                <Button size="lg">Large</Button>
                <Button size="icon">⚙️</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Card className="dashboard-card">
            <CardHeader>
              <CardTitle>Dashboard Card</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                This card has enhanced hover effects with a gradient top border and smooth transitions.
              </p>
            </CardContent>
          </Card>

          <Card className="glass-card">
            <CardHeader>
              <CardTitle>Glass Card</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                This card features a modern glass morphism effect with backdrop blur.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Standard Card</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                A standard card with subtle shadows and hover effects.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Form Elements */}
        <Card>
          <CardHeader>
            <CardTitle>Form Elements</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="form-label">
              <label htmlFor="sample-input">Sample Input</label>
              <input
                id="sample-input"
                type="text"
                className="form-input"
                placeholder="Type something here..."
              />
            </div>
            <div className="form-label">
              <label htmlFor="sample-textarea">Sample Textarea</label>
              <textarea
                id="sample-textarea"
                className="form-input"
                rows={3}
                placeholder="Enter your message..."
              />
            </div>
          </CardContent>
        </Card>

        {/* Status Indicators */}
        <Card>
          <CardHeader>
            <CardTitle>Status Indicators</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              <div className="status-indicator success">
                <div className="w-2 h-2 rounded-full bg-current"></div>
                Success Status
              </div>
              <div className="status-indicator warning">
                <div className="w-2 h-2 rounded-full bg-current"></div>
                Warning Status
              </div>
              <div className="status-indicator error">
                <div className="w-2 h-2 rounded-full bg-current"></div>
                Error Status
        </div>
      </div>
          </CardContent>
        </Card>

        {/* Table Example */}
        <Card>
          <CardHeader>
            <CardTitle>Modern Table</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-lg border bg-table text-[var(--table-text)]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>John Doe</TableCell>
                    <TableCell><Badge className="bg-success-100 text-success-700">Active</Badge></TableCell>
                    <TableCell>2024-01-15</TableCell>
                    <TableCell><Button size="sm" variant="outline">Edit</Button></TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Jane Smith</TableCell>
                    <TableCell><Badge className="bg-warning-100 text-warning-700">Pending</Badge></TableCell>
                    <TableCell>2024-01-14</TableCell>
                    <TableCell><Button size="sm" variant="outline">Edit</Button></TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Bob Johnson</TableCell>
                    <TableCell><Badge className="bg-error-100 text-error-700">Inactive</Badge></TableCell>
                    <TableCell>2024-01-13</TableCell>
                    <TableCell><Button size="sm" variant="outline">Edit</Button></TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Typography */}
        <Card>
          <CardHeader>
            <CardTitle>Typography</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h1 className="text-4xl font-bold">Heading 1</h1>
              <h2 className="text-3xl font-bold">Heading 2</h2>
              <h3 className="text-2xl font-semibold">Heading 3</h3>
              <h4 className="text-xl font-semibold">Heading 4</h4>
              <h5 className="text-lg font-medium">Heading 5</h5>
              <h6 className="text-base font-medium">Heading 6</h6>
            </div>
            <Separator />
            <div className="space-y-2">
              <p className="text-base">This is a regular paragraph with <strong>bold text</strong> and <em>italic text</em>.</p>
              <p className="text-sm text-muted-foreground">This is small muted text for secondary information.</p>
              <p className="text-xs text-muted-foreground">This is extra small text for fine print.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
