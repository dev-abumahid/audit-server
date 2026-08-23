import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { supplier_service } from './supplier.service.js';

const get_all_supplier = catchAsync(async (req, res) => {
  const result = await supplier_service.get_all_supplier_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All suppliers fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const get_single_supplier = catchAsync(async (req, res) => {
  const result = await supplier_service.get_single_supplier_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single supplier fetched successfully.',
    data: result,
    meta: {},
  });
});

const create_supplier = catchAsync(async (req, res) => {
  const result = await supplier_service.create_supplier_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Supplier created successfully.',
    data: result,
    meta: {},
  });
});

const update_supplier = catchAsync(async (req, res) => {
  const result = await supplier_service.update_supplier_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Supplier updated successfully.',
    data: result,
    meta: {},
  });
});

const delete_supplier = catchAsync(async (req, res) => {
  const result = await supplier_service.delete_supplier_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Supplier deleted successfully.',
    data: result,
    meta: {},
  });
});

const discover_suppliers = catchAsync(async (req, res) => {
  const result = await supplier_service.discover_suppliers_for_org(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Supplier candidates discovered successfully.',
    data: result,
    meta: {},
  });
});

const bulk_update_status = catchAsync(async (req, res) => {
  const result = await supplier_service.bulk_update_status_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Suppliers updated successfully.',
    data: result,
    meta: {},
  });
});

const bulk_delete = catchAsync(async (req, res) => {
  const result = await supplier_service.bulk_delete_suppliers_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Suppliers deleted successfully.',
    data: result,
    meta: {},
  });
});

export const supplier_controller = {
  get_all_supplier,
  get_single_supplier,
  create_supplier,
  update_supplier,
  delete_supplier,
  discover_suppliers,
  bulk_update_status,
  bulk_delete,
};
