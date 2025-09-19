import { Download } from "lucide-react";

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onExport: (format: string) => void;
}

export function ExportDialog({ isOpen, onClose, onExport }: ExportDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md p-6 bg-white rounded-lg shadow-lg">
        <h2 className="mb-4 text-xl font-bold text-emerald-600">Export Crawled Data</h2>

        <div className="space-y-4">
          <button
            onClick={() => {
              onExport('json');
              onClose();
            }}
            className="flex items-center justify-between w-full p-3 border rounded-lg hover:bg-gray-100"
          >
            <span className="font-medium">JSON Format</span>
            <Download className="w-5 h-5 text-emerald-600" />
          </button>

          <button
            onClick={() => {
              onExport('csv');
              onClose();
            }}
            className="flex items-center justify-between w-full p-3 border rounded-lg hover:bg-gray-100"
          >
            <span className="font-medium">CSV Format</span>
            <Download className="w-5 h-5 text-emerald-600" />
          </button>
        </div>

        <div className="flex justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
