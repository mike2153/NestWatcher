import { useState, useEffect, useCallback } from 'react';
import { X, Database, FolderOpen, Package, Plus, Trash2, AlertTriangle, ChevronRight } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Button } from '@/components/ui/button';
import type { Machine } from '../../../shared/src';
import { DatabaseSettings } from './settings/DatabaseSettings';
import { FolderPathsSettings } from './settings/FolderPathsSettings';
import { GrundnerSettings } from './settings/GrundnerSettings';
import { MachineSettings } from './settings/MachineSettings';
import { ValidationWarningsSettings } from './settings/ValidationWarningsSettings';

type SettingsCategory = 'database' | 'folders' | 'grundner' | 'validation' | 'machine';

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
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-2xl w-[90vw] h-[85vh] max-w-6xl flex overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Sidebar */}
        <div className="w-72 bg-[var(--sidebar)] border-r border-[var(--sidebar-border)] flex flex-col shrink-0">
          {/* Sidebar Header */}
          <div className="px-6 h-[72px] flex items-center border-b border-[var(--sidebar-border)] bg-[var(--sidebar)]">
            <div>
              <h2 className="text-lg font-bold text-[var(--sidebar-foreground)] tracking-tight">Settings</h2>
              <p className="text-xs text-[var(--muted-foreground)] uppercase tracking-wider font-semibold mt-0.5">Configuration</p>
            </div>
          </div>

          {/* Main Categories */}
          <div className="flex-1 overflow-y-auto py-6 px-4 space-y-8">
            {/* General Section */}
            <div className="space-y-1">
              <div className="px-2 mb-2 text-xs font-bold uppercase text-[var(--muted-foreground)] tracking-wider">General</div>
              <nav className="space-y-1">
                {[
                  { id: 'database', label: 'Database', icon: Database },
                  { id: 'folders', label: 'Folder Paths', icon: FolderOpen },
                  { id: 'grundner', label: 'Grundner', icon: Package },
                  { id: 'validation', label: 'Validation', icon: AlertTriangle },
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setActiveCategory(item.id as SettingsCategory)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 group relative overflow-hidden",
                      activeCategory === item.id
                        ? "bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)] shadow-sm ring-1 ring-black/5"
                        : "text-[var(--sidebar-foreground)] hover:bg-[var(--sidebar-accent)]/50 hover:text-[var(--sidebar-foreground)]"
                    )}
                  >
                    <item.icon className={cn("size-4 transition-colors", activeCategory === item.id ? "text-[var(--primary)]" : "text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]")} />
                    <span className="flex-1 text-left">{item.label}</span>
                    {activeCategory === item.id && <ChevronRight className="size-3.5 opacity-50" />}
                  </button>
                ))}
              </nav>
            </div>

            {/* Machines Section */}
            <div className="space-y-1">
              <div className="flex items-center justify-between px-2 mb-2">
                <span className="text-xs font-bold uppercase text-[var(--muted-foreground)] tracking-wider">
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
                    className={cn(
                      "group flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer relative",
                      selectedMachineId === machine.machineId && activeCategory === 'machine'
                        ? "bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)] shadow-sm ring-1 ring-black/5"
                        : "text-[var(--sidebar-foreground)] hover:bg-[var(--sidebar-accent)]/50 hover:text-[var(--sidebar-foreground)]"
                    )}
                    onClick={() => handleSelectMachine(machine.machineId)}
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className={cn("size-2 rounded-full shrink-0", machine.nestpickEnabled ? "bg-emerald-500" : "bg-gray-300")} />
                      <span className="truncate">{machine.name}</span>
                    </div>
                    {selectedMachineId === machine.machineId && activeCategory === 'machine' && <ChevronRight className="size-3.5 opacity-50 mr-2" />}

                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity absolute right-2 bg-[var(--sidebar-accent)] pl-2 shadow-[-8px_0_8px_-4px_var(--sidebar-accent)]">
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

        {/* Content Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Content Header */}
          <div className="px-10 h-[72px] flex items-center justify-between border-b border-[var(--border)] bg-[var(--card)] shrink-0">
            <div>
              <h3 className="text-xl font-bold text-[var(--foreground)] tracking-tight">
                {activeCategory === 'database' && 'Database Configuration'}
                {activeCategory === 'folders' && 'Folder Path Management'}
                {activeCategory === 'grundner' && 'Grundner Integration'}
                {activeCategory === 'validation' && 'Validation Rules'}
                {activeCategory === 'machine' && 'Machine Settings'}
              </h3>
              <p className="text-sm text-[var(--muted-foreground)]">Manage your preferences and configurations</p>
            </div>

            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="rounded-full hover:bg-[var(--muted)]"
            >
              <X className="size-5" />
            </Button>
          </div>

          {/* Content Body */}
          <div className="flex-1 overflow-y-auto p-10 bg-[var(--background-subtle)]">
            {activeCategory === 'database' && <DatabaseSettings />}
            {activeCategory === 'folders' && <FolderPathsSettings />}
            {activeCategory === 'grundner' && <GrundnerSettings />}
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