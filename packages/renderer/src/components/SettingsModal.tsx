import { useState, useEffect, useCallback } from 'react';
import { X, Database, FolderOpen, Package, Plus, Trash2, AlertTriangle } from 'lucide-react';
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border border-border rounded-lg shadow-xl w-[90vw] h-[80vh] max-w-6xl flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-72 bg-sidebar border-r border-sidebar-border flex flex-col">
          {/* Sidebar Header */}
          <div className="px-6 py-4 border-b border-sidebar-border">
            <h2 className="text-lg font-semibold text-sidebar-foreground">SETTINGS</h2>
          </div>

          {/* Main Categories */}
          <div className="flex-1 overflow-y-auto">
            <nav className="p-3 space-y-1">
              <button
                onClick={() => setActiveCategory('database')}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeCategory === 'database'
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
                }`}
              >
                <Database className="w-4 h-4" />
                Database
              </button>

              <button
                onClick={() => setActiveCategory('folders')}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeCategory === 'folders'
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
                }`}
              >
                <FolderOpen className="w-4 h-4" />
                Folder Paths
              </button>

              <button
                onClick={() => setActiveCategory('grundner')}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeCategory === 'grundner'
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
                }`}
              >
                <Package className="w-4 h-4" />
                Grundner
              </button>

              <button
                onClick={() => setActiveCategory('validation')}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeCategory === 'validation'
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
                }`}
              >
                <AlertTriangle className="w-4 h-4" />
                Validation
              </button>
            </nav>

            {/* Separator */}
            <div className="mx-6 my-3 border-t border-sidebar-border" />

            {/* Machines Section */}
            <div className="p-3">
              <div className="flex items-center justify-between px-3 mb-2">
                <span className="text-xs font-semibold text-sidebar-foreground/60 uppercase tracking-wider">
                  Machines
                </span>
                <button
                  onClick={handleAddMachine}
                  className="p-1 hover:bg-sidebar-accent rounded transition-colors"
                  title="Add Machine"
                >
                  <Plus className="w-4 h-4 text-sidebar-foreground" />
                </button>
              </div>

              <div className="space-y-1">
                {machines.map((machine) => (
                  <div
                    key={machine.machineId}
                    className={`group flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                      selectedMachineId === machine.machineId && activeCategory === 'machine'
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
                    }`}
                    onClick={() => handleSelectMachine(machine.machineId)}
                  >
                    <span className="truncate">{machine.name}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteMachine(machine.machineId);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/10 rounded transition-all"
                      title="Delete Machine"
                    >
                      <Trash2 className="w-3 h-3 text-destructive" />
                    </button>
                  </div>
                ))}
                {machines.length === 0 && (
                  <div className="px-3 py-2 text-sm text-sidebar-foreground/60">
                    No machines configured
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col">
          {/* Content Header */}
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <h3 className="text-lg font-semibold">
              {activeCategory === 'database' && 'Database'}
              {activeCategory === 'folders' && 'Folder Paths'}
              {activeCategory === 'grundner' && 'Grundner'}
              {activeCategory === 'validation' && 'Validation'}
              {activeCategory === 'machine' && 'Machine Configuration'}
            </h3>
            <button
              onClick={onClose}
              className="p-1 hover:bg-muted rounded-md transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content Body */}
          <div className="flex-1 overflow-y-auto p-6">
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