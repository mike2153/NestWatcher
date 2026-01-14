import { useState, useEffect, useCallback } from 'react';
import { X, Database, FolderOpen, Package, FileDown, Plus, Trash2, AlertTriangle, ChevronRight } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Button } from '@/components/ui/button';
import type { Machine } from '../../../shared/src';
import { DatabaseSettings } from './settings/DatabaseSettings';
import { FolderPathsSettings } from './settings/FolderPathsSettings';
import { GrundnerSettings } from './settings/GrundnerSettings';
import { InventoryExportSettings } from './settings/InventoryExportSettings';
import { MachineSettings } from './settings/MachineSettings';
import { ValidationWarningsSettings } from './settings/ValidationWarningsSettings';

type SettingsCategory = 'database' | 'folders' | 'grundner' | 'inventoryExport' | 'validation' | 'machine';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('database');
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState<number | null>(null);

  const loadMachines = useCallback(async () => {
    const res = await window.api.machines.list();
    if (res.ok) {
      setMachines(res.value.items);
      if (res.value.items.length > 0 && !selectedMachineId) {
        setSelectedMachineId(res.value.items[0].machineId);
      }
    }
  }, [selectedMachineId]);

  useEffect(() => {
    if (isOpen) {
      loadMachines();
    }
  }, [isOpen, loadMachines]);

  const handleAddMachine = async () => {
    const res = await window.api.machines.save({
      name: 'New Machine',
      apJobfolder: '',
      nestpickFolder: '',
      nestpickEnabled: true
    });
    if (res.ok) {
      await loadMachines();
      setSelectedMachineId(res.value.machineId);
      setActiveCategory('machine');
    }
  };

  const handleDeleteMachine = async (machineId: number) => {
    if (!confirm('Delete this machine?')) return;
    const res = await window.api.machines.delete(machineId);
    if (res.ok) {
      await loadMachines();
      if (selectedMachineId === machineId) {
        setSelectedMachineId(machines.find(m => m.machineId !== machineId)?.machineId || null);
      }
    }
  };

  const handleSelectMachine = (machineId: number) => {
    setSelectedMachineId(machineId);
    setActiveCategory('machine');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-none animate-in fade-in duration-200">
      <div className="border rounded-xl shadow-2xl w-[90vw] h-[85vh] max-w-6xl flex overflow-hidden animate-in zoom-in-95 duration-200" style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}>
        {/* Sidebar - matches NC Cat exactly */}
        <div className="w-48 border-r shrink-0 flex flex-col" style={{ backgroundColor: 'var(--sidebar)' }}>
          {/* Sidebar Header */}
          <div className="flex items-center h-12 px-3">
            <span className="px-2 font-semibold text-lg">Settings</span>
          </div>

          {/* Main Categories */}
          <div className="flex-1 overflow-y-auto p-2 space-y-4">
            {/* General Section */}
            <div className="space-y-1">
              <nav className="space-y-1">
                {[
                  { id: 'database', label: 'Database', icon: Database },
                  { id: 'folders', label: 'Folder Paths', icon: FolderOpen },
                  { id: 'grundner', label: 'Grundner', icon: Package },
                  { id: 'inventoryExport', label: 'Inventory Export', icon: FileDown },
                  { id: 'validation', label: 'Validation', icon: AlertTriangle },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setActiveCategory(item.id as SettingsCategory)}
                    className="flex h-10 w-full items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 text-left text-sm font-medium transition-colors hover:bg-muted hover:text-foreground font-sans"
                    style={activeCategory === item.id
                      ? { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }
                      : { color: 'var(--muted-foreground)' }
                    }
                  >
                    <item.icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                ))}
              </nav>
            </div>

            {/* Machines Section */}
            <div className="space-y-1">
              <div className="flex items-center justify-between px-2 mb-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Machines
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 h-6 w-6"
                  onClick={handleAddMachine}
                  title="Add Machine"
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>

              <div className="space-y-1">
                {machines.map((machine) => (
                  <div
                    key={machine.machineId}
                    className="group flex items-center gap-3 overflow-hidden rounded-md pl-4 pr-3 h-10 text-sm font-medium transition-colors hover:bg-muted hover:text-foreground cursor-pointer relative font-sans"
                    style={selectedMachineId === machine.machineId && activeCategory === 'machine'
                      ? { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }
                      : { color: 'var(--muted-foreground)' }
                    }
                    onClick={() => handleSelectMachine(machine.machineId)}
                  >
                    <div className={cn("size-2 rounded-full shrink-0", machine.nestpickEnabled ? "bg-emerald-500" : "bg-gray-300")} />
                    <span className="truncate flex-1">{machine.name}</span>

                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity absolute right-2 bg-muted pl-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 h-6 w-6 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteMachine(machine.machineId);
                        }}
                        title="Delete Machine"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
                {machines.length === 0 && (
                  <div className="px-3 py-4 text-center border-2 border-dashed border-[var(--border)] rounded-lg">
                    <p className="text-xs text-[var(--muted-foreground)] mb-2">No machines</p>
                    <Button variant="outline" size="sm" onClick={handleAddMachine} className="text-xs h-7">Add First</Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Content Area - matches NC Cat structure */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Content Header - matches NC Cat header style */}
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4 bg-card/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/80">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold">
                {activeCategory === 'database' && 'Database Configuration'}
                {activeCategory === 'folders' && 'Folder Path Management'}
                {activeCategory === 'grundner' && 'Grundner Integration'}
                {activeCategory === 'inventoryExport' && 'Inventory Export'}
                {activeCategory === 'validation' && 'Validation Rules'}
                {activeCategory === 'machine' && 'Machine Settings'}
              </h1>
            </div>

            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="rounded-full hover:bg-muted"
            >
              <X className="size-5" />
            </Button>
          </div>

          {/* Content Body - no background, inherits from bg-background */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeCategory === 'database' && <DatabaseSettings />}
            {activeCategory === 'folders' && <FolderPathsSettings />}
            {activeCategory === 'grundner' && <GrundnerSettings />}
            {activeCategory === 'inventoryExport' && <InventoryExportSettings />}
            {activeCategory === 'validation' && <ValidationWarningsSettings />}
            {activeCategory === 'machine' && (
              <MachineSettings
                machineId={selectedMachineId}
                onMachineUpdated={loadMachines}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}