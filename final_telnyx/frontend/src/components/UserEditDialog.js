import React from 'react';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Button,
  TextField,
  Box,
} from '@mui/material';

// Memoized dialog component to prevent parent re-renders when typing
const UserEditDialog = React.memo(({ 
  open, 
  editingUser, 
  formData, 
  onClose, 
  onInputChange, 
  onSubmit 
}) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {editingUser ? 'Edit User' : 'Add New User'}
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
          <TextField
            label="First Name"
            name="firstname"
            value={formData.firstname || ''}
            onChange={onInputChange}
            fullWidth
            required
            autoComplete="off"
          />
          <TextField
            label="Last Name"
            name="lastname"
            value={formData.lastname || ''}
            onChange={onInputChange}
            fullWidth
            required
            autoComplete="off"
          />
          <TextField
            label="Phone"
            name="phone"
            value={formData.phone || ''}
            onChange={onInputChange}
            fullWidth
            required
            placeholder="+15551234567"
            autoComplete="off"
          />
          <TextField
            label="Address"
            name="address"
            value={formData.address || ''}
            onChange={onInputChange}
            fullWidth
            autoComplete="off"
          />
          <TextField
            label="Email"
            name="email"
            type="email"
            value={formData.email || ''}
            onChange={onInputChange}
            fullWidth
            autoComplete="off"
          />
          <TextField
            label="Notes"
            name="notes"
            value={formData.notes || ''}
            onChange={onInputChange}
            fullWidth
            multiline
            rows={3}
            autoComplete="off"
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={onSubmit} variant="contained">
          {editingUser ? 'Update' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
});

UserEditDialog.displayName = 'UserEditDialog';

export default UserEditDialog;

